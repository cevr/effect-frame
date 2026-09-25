/* oxlint-disable effect/noGlobals -- Bun.serve and fetch are this proof's platform boundary: a real socket, a browser with no script, and the same browser after its bundle loads. */
import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, HttpServer } from "effect-frame/actor";
import { ActorTransport, Form, HttpTransport } from "effect-frame/actor/client";
import type { DurableReceipt, IdentifiedCommandHandle } from "effect-frame/actor/client";
import { Dom, Html, View } from "effect-frame/view";
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { TasksSnapshot, Wire } from "../plain-form-fixture.js";
import {
  AddTask,
  Tasks,
  board,
  hiddenOf,
  hiddenValue,
  formPosts,
  makeWire,
  recordedTransport,
} from "../plain-form-fixture.js";

/**
 * A plain-form resubmission and a scripted retry settle by one mechanism
 * (#29 §5, #21 §5, #32 §4). One real socket serves the page, the form
 * route, and the JSON routes over one in-process host. The browser posts
 * with `fetch` and no script; the same browser, once its bundle loads,
 * hydrates the page and sends through `HttpTransport` to `/send` and
 * `/call`. Every path reaches the host's one `send`, and the host settles
 * each by the command id: one admission, one receipt, one revision.
 */

const actorPrefix = "/actors";

type Handle = IdentifiedCommandHandle<TasksSnapshot, "remote">;

interface PageProps {
  /** Receives the handle of the scripted send. The server never sends. */
  readonly sent: Deferred.Deferred<Handle>;
}

/** The add form alone, with its scripted handle handed to the test. */
const AddPage = (props: PageProps) =>
  Effect.gen(function* () {
    const tasks = yield* Actor.remote(Tasks, board);
    const add = yield* View.form({
      ref: tasks,
      contract: Tasks,
      key: board,
      message: AddTask,
      typed: ["title", "done", "note"],
      endpoint: actorPrefix,
      returnTo: "/",
      onSend: (handle) => Deferred.succeed(props.sent, handle),
    });
    return (
      <form id="add" onSubmit={add.submit}>
        <input id="title" name="title" />
        <input id="done" type="checkbox" name="done" />
        <textarea id="note" name="note"></textarea>
        <button type="submit">add</button>
      </form>
    );
  });

/** The document, with the refusal it redraws when the form route draws it. */
const documentOf = (props: PageProps) =>
  Effect.scoped(
    Effect.gen(function* () {
      const body = yield* Html.renderToString(AddPage, props);
      const issues = yield* Effect.serviceOption(Form.FormContext);
      const script = yield* Option.match(issues, {
        onNone: () => Effect.succeed(""),
        onSome: (found) =>
          Effect.map(Form.encodeIssues(found), (json) =>
            Html.jsonScript(Form.issuesScriptId, json),
          ),
      });
      return `<main id="app">${body}</main>${script}`;
    }),
  );

interface Served {
  readonly url: string;
  readonly wire: Wire;
  readonly host: Context.Context<ActorTransport>;
  readonly sent: Deferred.Deferred<Handle>;
}

const serve = Effect.gen(function* () {
  const wire = yield* makeWire;
  const sent = yield* Deferred.make<Handle>();
  const host = yield* Layer.build(recordedTransport(wire));
  const page = documentOf({ sent });
  const actors = yield* Effect.provideContext(
    HttpServer.make({ principal: HttpServer.anonymous }),
    host,
  );
  const forms = yield* Effect.provideContext(
    HttpServer.form({
      contracts: [Tasks],
      principal: HttpServer.anonymous,
      login: Option.none(),
      render: () => page,
    }),
    Context.add(host, ActorTransport, formPosts(Context.get(host, ActorTransport))),
  );
  const run = Effect.runPromiseWith(host);
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch: (request) => {
          const url = new URL(request.url);
          if (url.pathname === `${actorPrefix}/form`) {
            return run(forms(request));
          }
          if (url.pathname.startsWith(actorPrefix)) {
            const stripped = new URL(request.url);
            stripped.pathname = url.pathname.slice(actorPrefix.length);
            return run(actors(new Request(stripped, request)));
          }
          return run(
            Effect.map(
              Effect.orDie(page),
              (html) => new Response(html, { headers: { "content-type": "text/html" } }),
            ),
          );
        },
      }),
    ),
    (running) => Effect.promise(() => running.stop(true)),
  );
  const port = Option.getOrElse(Option.fromNullishOr(server.port), () => 0);
  const served: Served = { url: `http://127.0.0.1:${String(port)}`, wire, host, sent };
  return served;
});

interface Reply {
  readonly status: number;
  readonly body: string;
}

/** The browser with no script: redirects are read, not followed. */
const request = (url: string, init: RequestInit) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetch(url, { ...init, redirect: "manual" }));
    const body = yield* Effect.promise(() => response.text());
    const reply: Reply = { status: response.status, body };
    return reply;
  });

const getPage = (served: Served) => Effect.map(request(served.url, {}), (reply) => reply.body);

const post = (served: Served, body: string) =>
  request(`${served.url}${actorPrefix}/form`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

/** The rendered add form, filled the way a browser fills it. */
const fill = (html: string, typed: ReadonlyArray<[string, string]>): string =>
  Form.toBody(Form.fromEntries([...hiddenOf(html, "add"), ...typed]));

/** The host's committed state once it reaches `revision`. */
const committed = (served: Served, revision: number) =>
  Effect.scoped(
    Effect.flatMap(Actor.remote(Tasks, board), (tasks) =>
      Stream.runHead(
        Stream.filter(tasks.applied.changes, (applied) => applied.revision.value >= revision),
      ),
    ),
  ).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.timeout("2 seconds"),
    Effect.orDie,
    Effect.provideContext(served.host),
  );

/** The browser's own transport: the JSON routes on the same socket. */
const client = (served: Served) =>
  Layer.build(
    HttpTransport.layer({
      baseUrl: `${served.url}${actorPrefix}`,
      reconnect: HttpTransport.defaultReconnect,
    }),
  );

/** Put a whole document into the body: the app root and its scripts. */
const installDocument = (html: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      document.body.innerHTML = html;
      return Option.getOrThrow(
        Option.filter(
          Option.fromNullishOr(document.getElementById("app")),
          (found): found is HTMLElement => found instanceof HTMLElement,
        ),
      );
    }),
    () => Effect.sync(() => void (document.body.innerHTML = "")),
  );

const element = <T extends Element>(root: ParentNode, selector: string, type: new () => T) =>
  Option.getOrThrow(
    Option.filter(
      Option.fromNullishOr(root.querySelector(selector)),
      (found): found is T => found instanceof type,
    ),
  );

/**
 * The bundle loads on the page the browser holds: hydrate it under the
 * refusal it carries, if any, with no mismatch.
 */
const hydrate = (served: Served, html: string) =>
  Effect.gen(function* () {
    const root = yield* installDocument(html);
    const carried = yield* Option.match(Dom.readJsonScript(Form.issuesScriptId), {
      onNone: () => Effect.succeed(Option.none<Form.FormIssues>()),
      onSome: (json) => Effect.map(Form.decodeIssues(json), Option.some),
    });
    const hydration = Dom.hydrate(root);
    yield* Form.provideIssues(carried)(
      View.mount(AddPage, { sent: served.sent }, hydration.host, root),
    );
    yield* View.flush;
    const report = yield* hydration.finish;
    expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
    return element(root, "#add", HTMLFormElement);
  });

/** Submit as a person would: the event, cancelable, from the form. */
const submit = (form: HTMLFormElement) =>
  Effect.sync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

/** Every host send carried one id and one payload: the bytes the receipt hashes. */
const expectOneCommand = (wire: Wire, commandId: string, count: number) =>
  Effect.gen(function* () {
    const sends = yield* Ref.get(wire.sends);
    expect(sends).toHaveLength(count);
    expect(new Set(sends.map((send) => String(send.commandId)))).toEqual(new Set([commandId]));
    expect(new Set(sends.map((send) => send.payload)).size).toBe(1);
    const replies = yield* Ref.get(wire.replies);
    expect(replies).toHaveLength(count);
    // One admission: every later send found the first one's entry.
    expect(new Set(replies.map((reply) => reply.admitted)).size).toBe(1);
    return replies;
  });

/** The committed revision the host's `index`th receipt reported. */
const committedAt = (replies: ReadonlyArray<DurableReceipt>, index: number) =>
  Option.flatMap(Option.fromNullishOr(replies[index]), (found) => found.committed);

describe("a plain-form resubmission and a scripted retry (#29)", () => {
  it.scopedLive(
    "a plain post twice and a hydrated re-send of its id are admitted once and settle at one revision",
    () =>
      Effect.gen(function* () {
        const served = yield* serve;
        const html = yield* getPage(served);
        const rendered = hiddenValue(html, "add", "$command");
        const body = fill(html, [["title", "milk"]]);
        yield* Ref.set(served.wire.loseNextReply, true);

        // No script: the reply is lost, and the redraw keeps the id (Uncertain).
        const lost = yield* post(served, body);
        expect(lost.status).toBe(504);
        expect(hiddenValue(lost.body, "add", "$command")).toBe(rendered);
        yield* committed(served, 1);

        // The browser resubmits the redrawn form: the stored receipt, a 303.
        const resubmitted = yield* post(served, fill(lost.body, [["title", "milk"]]));
        expect(resubmitted.status).toBe(303);

        // The bundle loads on the 504 page; the binding adopts the same id and re-sends it.
        const handle = yield* Effect.provideContext(
          Effect.gen(function* () {
            const form = yield* hydrate(served, lost.body);
            expect(element(form, "#title", HTMLInputElement).value).toBe("milk");
            yield* submit(form);
            return yield* Deferred.await(served.sent);
          }),
          yield* client(served),
        );
        expect(String(handle.commandId)).toBe(rendered);
        const settled = yield* Effect.timeout(handle.settled, "5 seconds");

        const replies = yield* expectOneCommand(served.wire, rendered, 3);
        const first = Option.getOrThrow(Option.fromNullishOr(replies[0]));
        // Both later paths reached the stored receipt at the first admission's revision.
        expect(committedAt(replies, 1)).toEqual(Option.some(1));
        expect(committedAt(replies, 2)).toEqual(Option.some(1));
        expect(settled).toMatchObject({
          _tag: "Applied",
          admitted: first.admitted,
          revision: { _tag: "Committed", value: 1 },
        });
        const applied = yield* committed(served, 1);
        expect(applied.revision.value).toBe(1);
        expect(applied.state.tasks).toEqual([{ id: rendered, title: "milk", done: false }]);
      }),
    10_000,
  );

  it.scopedLive(
    "a scripted send left Uncertain retries, and the plain post of the same form reaches the same receipt",
    () =>
      Effect.gen(function* () {
        const served = yield* serve;
        const html = yield* getPage(served);
        const rendered = hiddenValue(html, "add", "$command");

        // The bundle loaded before the submit; the scripted send's reply is lost.
        const { handle, states } = yield* Effect.provideContext(
          Effect.gen(function* () {
            const form = yield* hydrate(served, html);
            element(form, "#title", HTMLInputElement).value = "milk";
            yield* Ref.set(served.wire.loseNextReply, true);
            yield* submit(form);
            const found = yield* Deferred.await(served.sent);
            const watching = yield* Effect.forkChild(
              Stream.runCollect(
                Stream.takeUntil(found.state.changes, (state) => state._tag === "Applied"),
              ),
            );
            return { handle: found, states: watching };
          }),
          yield* client(served),
        );
        expect(String(handle.commandId)).toBe(rendered);
        const settled = yield* Effect.timeout(handle.settled, "5 seconds");
        const seen = (yield* Fiber.join(states)).map((state) => state._tag);
        // The lost pass showed Uncertain; the retry re-sent the same id and settled.
        expect(seen).toContain("Uncertain");
        expect(seen.at(-1)).toBe("Applied");

        // The script is gone; the browser posts the same rendered form natively.
        const native = yield* post(served, fill(html, [["title", "milk"]]));
        expect(native.status).toBe(303);

        const replies = yield* expectOneCommand(served.wire, rendered, 3);
        const first = Option.getOrThrow(Option.fromNullishOr(replies[0]));
        expect(committedAt(replies, 2)).toEqual(Option.some(1));
        expect(settled).toMatchObject({
          _tag: "Applied",
          admitted: first.admitted,
          revision: { _tag: "Committed", value: 1 },
        });
        const applied = yield* committed(served, 1);
        expect(applied.revision.value).toBe(1);
        expect(applied.state.tasks).toEqual([{ id: rendered, title: "milk", done: false }]);
      }),
    10_000,
  );
});
