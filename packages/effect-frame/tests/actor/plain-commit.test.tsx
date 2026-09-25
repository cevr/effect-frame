/* oxlint-disable effect/noGlobals -- Bun.serve and fetch are this test's platform boundary: a real socket and a browser with no script. */
import { ActorHost, HttpServer, MailboxStore } from "effect-frame/actor";
import { ActorTransport, Form } from "effect-frame/actor/client";
import { Context, Deferred, Effect, Latch, Layer, Option, Schema } from "effect";
import type { Duration } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  Tasks,
  TasksDocument,
  TasksLive,
  board,
  hiddenOf,
  hiddenValue,
  policies,
} from "../plain-form-fixture.js";

/**
 * When a plain post answers (#21 §2, §5). The 303 follows the commit, not
 * the admission, so the page the browser reads next renders the committed
 * state. A commit that does not come in time answers 504 with the same
 * command id, and the identical resubmit reaches the stored receipt.
 *
 * The store's commit waits on a latch, so each test holds the commit
 * exactly as long as it needs: nothing here depends on timing luck.
 */

/** A memory store whose commit waits until `gate` opens. */
const heldStore = (gate: Latch.Latch): Layer.Layer<MailboxStore> =>
  Layer.effect(
    MailboxStore,
    Effect.gen(function* () {
      const store = yield* MailboxStore;
      return MailboxStore.of({
        ...store,
        commit: (commandId, state, wake) =>
          Effect.andThen(gate.await, store.commit(commandId, state, wake)),
      });
    }),
  ).pipe(Layer.provide(MailboxStore.layerMemory));

type Transport = ActorTransport["Service"];

const serveHeld = (
  gate: Latch.Latch,
  commitWithin: Duration.Input,
  route: (transport: Transport) => Transport = (transport) => transport,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.effect(
        ActorTransport,
        ActorHost.make({ implementations: [TasksLive], store: () => heldStore(gate) }),
      ).pipe(Layer.provide(policies), Layer.orDie),
    );
    const forms = yield* Effect.provideContext(
      HttpServer.make({
        prefix: "/actors",
        principal: HttpServer.anonymous,
        maxBodyBytes: HttpServer.defaultMaxBodyBytes,
        form: Option.some({
          contracts: [Tasks],
          login: Option.none(),
          render: () => TasksDocument,
          commitWithin,
        }),
      }),
      Context.add(context, ActorTransport, route(Context.get(context, ActorTransport))),
    );
    const run = Effect.runPromiseWith(context);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            if (new URL(request.url).pathname === "/actors/form") {
              return run(forms(request));
            }
            return run(
              Effect.map(
                Effect.orDie(TasksDocument),
                (html) => new Response(html, { headers: { "content-type": "text/html" } }),
              ),
            );
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );
    const port = Option.getOrElse(Option.fromNullishOr(server.port), () => 0);
    return {
      url: `http://127.0.0.1:${String(port)}`,
      transport: Context.get(context, ActorTransport),
    };
  });

const request = (url: string, init: RequestInit) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetch(url, { ...init, redirect: "manual" }));
    const body = yield* Effect.promise(() => response.text());
    return { status: response.status, body };
  });

type Fields = ReadonlyArray<readonly [string, string]>;

const post = (url: string, fields: Fields) =>
  request(`${url}/actors/form`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: Form.toBody(Form.fromEntries(fields)),
  });

/** The board's committed revision, read the moment it is asked for. */
const revisionNow = (transport: Transport) =>
  Effect.gen(function* () {
    const key = yield* Schema.encodeEffect(Tasks.key)(board);
    const projection = yield* transport.snapshot({ contract: "Tasks", version: 1, key });
    return projection.revision;
  }).pipe(Effect.orDie);

describe("when a plain post answers", () => {
  it.scopedLive("the 303 waits for the commit, so a read right after it sees the write", () =>
    Effect.gen(function* () {
      const gate = yield* Latch.make(false);
      const served = yield* serveHeld(gate, "5 seconds");
      const page = yield* request(served.url, {});
      const fields: Fields = [...hiddenOf(page.body, "add"), ["title", "milk"]];

      const answer = yield* Deferred.make<Effect.Success<ReturnType<typeof post>>>();
      yield* Effect.forkScoped(
        Effect.flatMap(post(served.url, fields), (reply) => Deferred.succeed(answer, reply)),
      );
      // The command is admitted, and its commit is held: no answer yet.
      yield* Effect.sleep("200 millis");
      expect(yield* Deferred.isDone(answer)).toBe(false);
      expect(yield* revisionNow(served.transport)).toBe(0);

      yield* Latch.open(gate);
      const answered = yield* Deferred.await(answer);
      expect(answered.status).toBe(303);
      // No wait: the commit is readable the moment the 303 arrives.
      expect(yield* revisionNow(served.transport)).toBe(1);
    }),
  );

  it.scopedLive(
    "a commit that does not come in time answers 504 with the same id, and the resubmit hits the receipt",
    () =>
      Effect.gen(function* () {
        const gate = yield* Latch.make(false);
        const served = yield* serveHeld(gate, "150 millis");
        const page = yield* request(served.url, {});
        const rendered = hiddenValue(page.body, "add", "$command");
        const fields: Fields = [...hiddenOf(page.body, "add"), ["title", "milk"]];

        const late = yield* post(served.url, fields);
        expect(late.status).toBe(504);
        // The command may be in the mailbox, so the redrawn form keeps its id.
        expect(hiddenValue(late.body, "add", "$command")).toBe(rendered);
        expect(hiddenValue(late.body, "add", "$uncertain")).toBe("true");

        yield* Latch.open(gate);
        const resubmitted = yield* post(served.url, [
          ...hiddenOf(late.body, "add"),
          ["title", "milk"],
        ]);
        expect(resubmitted.status).toBe(303);
        // One command, applied once.
        expect(yield* revisionNow(served.transport)).toBe(1);
      }),
  );
  it.scopedLive("a transport that never answers still answers 504 with the same id", () =>
    Effect.gen(function* () {
      const gate = yield* Latch.make(true);
      // A remote host that is never reached: its own deadline never starts.
      const served = yield* serveHeld(gate, "150 millis", (transport) => ({
        ...transport,
        call: () => Effect.never,
      }));
      const page = yield* request(served.url, {});
      const rendered = hiddenValue(page.body, "add", "$command");

      const late = yield* post(served.url, [...hiddenOf(page.body, "add"), ["title", "milk"]]);
      expect(late.status).toBe(504);
      expect(hiddenValue(late.body, "add", "$command")).toBe(rendered);
      expect(hiddenValue(late.body, "add", "$uncertain")).toBe("true");
    }),
  );
});
