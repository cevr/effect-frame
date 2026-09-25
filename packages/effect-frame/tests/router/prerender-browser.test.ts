/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noTryCatch -- this proof drives real WebKit and Chrome pages through Bun.WebView against a real Bun server that serves a real prerender build. */
/**
 * A prerendered page in a real browser (#86). The build writes a page with
 * one actor island, and writes the real bundle of `browser/prerender-app.tsx`
 * as its `client.js`. A Bun server serves the loaded generation before an
 * actor HTTP host. WebKit and Chrome load the file, run the module tag the
 * build wrote, hydrate through the bundle with no mismatch, and resume the
 * island over HTTP to a count committed after the build.
 */
import { tmpdir } from "node:os";
import {
  Actor,
  ActorHost,
  Behavior,
  CommandId,
  HttpServer,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor";
import * as Prerender from "effect-frame/router/prerender";
import { Html } from "effect-frame/view";
import { BunServices } from "@effect/platform-bun";
import type { Context } from "effect";
import { Effect, Exit, FileSystem, Layer, Match, Option, Schema, Scope } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "bun:test";
import * as H from "./browser/harness.js";
import type { PrerenderWindow } from "./browser/prerender-app.js";
import { NotFound, Note, Resume, bakedId, noteRoute } from "./browser/prerender-page.js";

const chrome = await H.capabilities("chrome");
const webkit = await H.capabilities("webkit");

let bundled: Promise<string> | undefined;
const bundleOnce = (): Promise<string> => {
  bundled ??= H.bundle("prerender-app.tsx");
  return bundled;
};

type NoteSnapshot = { readonly count: number };
type NoteMessage = { readonly _tag: "Add"; readonly amount: number };

const NoteLive = implementTransparent(Note, {
  behavior: Behavior.reducer<NoteSnapshot, NoteMessage>({
    initial: { count: 0 },
    reduce: (state, message) =>
      Match.type<NoteMessage>().pipe(
        Match.tagsExhaustive({ Add: (add) => ({ count: state.count + add.amount }) }),
      )(message),
  }),
});

const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));
const commandId = Schema.decodeSync(CommandId);

const add = (id: string) =>
  Effect.gen(function* () {
    const note = yield* Actor.remote(Note, "n1");
    return yield* note.call(
      { _tag: "Add", amount: 1 },
      { commandId: commandId(id), timeout: "1 second" },
    );
  }).pipe(Effect.orDie, Effect.scoped);

/** The page's document: the frame around `#app`, and the island's resume script. */
const noteDocument = (_page: Prerender.Page) =>
  Effect.gen(function* () {
    const note = yield* Effect.orDie(Actor.remote(Note, "n1"));
    const snapshot = yield* note.applied.get;
    const payload = yield* Effect.orDie(Schema.encodeEffect(Resume)(snapshot));
    return {
      head: '<!doctype html><html><head><meta charset="utf-8"><title>prerender</title></head><body>',
      rootId: "app",
      tail: Html.jsonScript(bakedId, payload),
      end: "</body></html>",
    };
  });

interface Served {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/** Build the site over a fresh store, commit once more, and serve it. */
const serveBuilt = async (): Promise<Served> => {
  const scope = Effect.runSync(Scope.make());
  const client = await bundleOnce();
  const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(Scope.provide(effect, scope));
  const store: Context.Context<ActorTransport> = await run(
    Layer.build(
      ActorHost.layer({ implementations: [NoteLive], store: ActorHost.memoryStore }).pipe(
        Layer.provide(policies),
        Layer.orDie,
      ),
    ),
  );
  await run(Effect.provideContext(add("before-build"), store));
  const handler = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: tmpdir(),
        prefix: "effect-frame-prerender-browser-",
      });
      const out = `${directory}/out`;
      yield* Prerender.build({
        routes: [noteRoute],
        notFound: NotFound,
        document: noteDocument,
        client: Effect.succeed(client),
        out,
        timeLimit: "5 seconds",
      }).pipe(Effect.provideContext(store));
      return yield* Prerender.serve(
        yield* Prerender.load(out),
        Effect.succeed(HttpServerResponse.text("not built", { status: 404 })),
      );
      // The proof's own entry point: the build and the server read real files.
      // @effect-diagnostics-next-line strictEffectProvide:off
    }).pipe(Effect.provide(BunServices.layer)),
  );
  // A commit after the build: the page must resume past its baked revision.
  await run(Effect.provideContext(add("after-build"), store));
  const actors = await run(
    Effect.provideContext(
      HttpServer.make({
        prefix: "/actors",
        principal: HttpServer.anonymous,
        maxBodyBytes: HttpServer.defaultMaxBodyBytes,
        form: Option.none(),
      }),
      store,
    ),
  );
  const actorsWeb = HttpEffect.toWebHandler(actors);
  const pagesWeb = HttpEffect.toWebHandler(handler);
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/actors/")) {
        return actorsWeb(request);
      }
      return pagesWeb(request);
    },
  });
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    stop: async () => {
      await server.stop(true);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

const proofs = (engine: H.Engine) => {
  it("the built page loads the client bundle, hydrates with no mismatch, and resumes past its baked revision", async () => {
    const served = await serveBuilt();
    const view = await H.open(engine, `${served.origin}/notes/n1`);
    try {
      await H.waitFor(view, "window.__prerender && window.__prerender.hydrated", "hydration");
      const seen = await view.evaluate<PrerenderWindow>("window.__prerender");
      expect(seen.moduleTags).toEqual([Prerender.clientScript]);
      expect(seen.report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      expect(seen.revision).toBe(1);
      expect(seen.countAtLoad).toBe("1");
      await H.waitFor(
        view,
        `document.getElementById("count")?.textContent === "2"`,
        "the count committed after the build",
      );
    } finally {
      view.close();
      await served.stop();
    }
  }, 30_000);
};

describe.skipIf(webkit === undefined)("a prerendered page in WebKit", () => proofs("webkit"));
describe.skipIf(chrome === undefined)("a prerendered page in Chrome", () => proofs("chrome"));
