import { registerDom } from "./dom-setup.js";

registerDom();

import { ActorTransport, QueryCache } from "effect-frame/actor/client";
import { Location, Route, renderDocument } from "effect-frame/router";
import type { AnyRoute, RenderedDocument, Router } from "effect-frame/router";
import { Context, Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { hydrateRoutes } from "../src/app.js";
import { inProcess } from "../src/notes.server.js";
import { listBranch } from "../src/routes.js";
import { notesDocument, renderPage } from "../src/server.js";
import { NotFound } from "../src/views.js";
import { has, install, locationAt, settle, textOf } from "./fixture.js";

/**
 * #18, #22, #25 §1: one route tree, one view, every rendering mode. The
 * list page's branch (`listBranch`: the shell, the lists layout, and
 * `ListView`) is mounted by each of the four constructors, rendered by the
 * server, and hydrated by the client with the one client path the app uses.
 * The views never learn the mode: the constructor is the only difference.
 */

const origin = "http://notes.test";
const inbox = `${origin}/lists/inbox`;

/** The list branch under one constructor, with what its views need. */
type ListTree = AnyRoute<ActorTransport | QueryCache | Router>;

interface Mode {
  readonly name: string;
  readonly tree: ListTree;
  /** The mode `renderDocument` reports. */
  readonly reported: RenderedDocument<unknown>["mode"];
  /** What the server wrote in the mount element. */
  readonly drawn: (html: string) => void;
  readonly resolvedAhead: number;
  /** The Notes snapshot reads the client makes: none when the document carried it. */
  readonly clientSnapshots: number;
}

const contentOf = (html: string): void => {
  expect(html).toContain('<h1 id="list-name">inbox</h1>');
  expect(html).toContain('<p id="counts">0 of 0 done</p>');
  expect(html).toContain('<form id="compose"');
};

const modes: ReadonlyArray<Mode> = [
  {
    name: "ssr",
    tree: Route.ssr("modes-ssr", listBranch),
    reported: "SSR",
    drawn: (html) => {
      contentOf(html);
      expect(html).toContain('id="frame-query-seed"');
      expect(html).toContain('id="frame-actor-seed"');
      expect(html).not.toContain('id="frame-records"');
    },
    resolvedAhead: 0,
    clientSnapshots: 0,
  },
  {
    name: "streamed",
    tree: Route.streamed("modes-streamed", listBranch),
    reported: "Streamed",
    drawn: (html) => {
      // The shell and the skeleton first; the values follow as records.
      expect(html).toContain('<p id="skeleton">loading</p>');
      expect(html).not.toContain('id="list-name"');
      expect(html).toContain('id="frame-records"');
      // The route's actor is settled before the shell draws: its seed is a
      // record of the first chunk.
      expect(html).toContain('{"_tag":"ActorSeed"');
    },
    // The whole stream is in the document before hydration: the client's
    // first frame draws the patched content in place of the skeleton.
    resolvedAhead: 1,
    clientSnapshots: 0,
  },
  {
    name: "awaitAll",
    tree: Route.awaitAll("modes-await", listBranch),
    reported: "AwaitAll",
    drawn: (html) => {
      contentOf(html);
      expect(html).toContain('id="frame-query-seed"');
      expect(html).toContain('id="frame-actor-seed"');
      expect(html).not.toContain('id="frame-records"');
    },
    resolvedAhead: 0,
    clientSnapshots: 0,
  },
  {
    name: "client",
    tree: Route.client("modes-client", listBranch),
    reported: "ClientOnly",
    drawn: (html) => {
      expect(html).toContain('<main id="app"></main>');
      expect(html).not.toContain("frame-query-seed");
      expect(html).not.toContain("frame-actor-seed");
    },
    resolvedAhead: 0,
    // Nothing was drawn, so the client's route reads the actor.
    clientSnapshots: 1,
  },
];

/** One in-memory host: the server's reads and the client's go to the same actors. */
const sharedHost = Layer.build(inProcess);

/** The client's services over the same host, with its snapshot reads counted. */
const clientOver = (host: Context.Context<ActorTransport>, snapshots: Array<string>) => {
  const inner = Context.get(host, ActorTransport);
  const counted = Layer.succeed(
    ActorTransport,
    ActorTransport.of({
      ...inner,
      snapshot: (address) =>
        Effect.andThen(
          Effect.sync(() => void snapshots.push(address.contract)),
          inner.snapshot(address),
        ),
    }),
  );
  return Layer.build(Layer.provideMerge(QueryCache.layer, counted));
};

const renderAt = (tree: ListTree, host: Context.Context<ActorTransport>) =>
  Effect.gen(function* () {
    const outcome = yield* renderDocument({
      routes: [tree],
      notFound: NotFound,
      url: new URL(inbox),
      document: notesDocument(),
      closeWhen: Effect.sleep("5 seconds"),
    }).pipe(Effect.provideContext(host));
    if (outcome._tag === "Redirect") {
      return yield* Effect.die(`redirected to ${outcome.location.href}`);
    }
    const chunks = yield* Stream.runCollect(outcome.body);
    return { mode: outcome.mode, html: Array.from(chunks).join("") };
  });

describe("one ListView in every rendering mode", () => {
  for (const mode of modes) {
    it.scopedLive(
      `the same ListView renders under ${mode.name}, and the client takes it over`,
      () =>
        Effect.gen(function* () {
          const host = yield* sharedHost;
          const rendered = yield* renderAt(mode.tree, host);
          expect(rendered.mode).toBe(mode.reported);
          mode.drawn(rendered.html);

          const root = yield* install(rendered.html);
          const snapshots: Array<string> = [];
          const client = yield* clientOver(host, snapshots);
          const { location } = yield* locationAt(inbox);
          const { report } = yield* hydrateRoutes([mode.tree])(root).pipe(
            Effect.provideService(Location, location),
            Effect.provideContext(client),
          );
          expect(report).toEqual({
            mismatches: [],
            unclaimed: 0,
            resolvedAhead: mode.resolvedAhead,
          });
          yield* settle(Effect.sync(() => textOf(root, "#counts") === "0 of 0 done"));
          expect(textOf(root, "#list-name")).toBe("inbox");
          expect(textOf(root, "#counts")).toBe("0 of 0 done");
          expect(has(root, "#compose")).toBe(true);
          expect(has(root, "#skeleton")).toBe(false);
          // The first frame held the notes: the route opened its reference
          // from the document and read the actor only in client-only mode.
          expect(snapshots.filter((name) => name === "Notes")).toHaveLength(mode.clientSnapshots);
        }),
    );
  }

  it.scopedLive("the app's trees name their modes by constructor", () =>
    Effect.gen(function* () {
      const host = yield* sharedHost;
      const modeAt = (path: string) =>
        Effect.scoped(
          Effect.map(renderPage(new URL(path, origin)), (outcome) => {
            if (outcome._tag === "Redirect") {
              return `Redirect ${outcome.location.pathname}`;
            }
            return outcome.mode;
          }),
        ).pipe(Effect.provideContext(host));
      expect(yield* modeAt("/")).toBe("Redirect /lists");
      expect(yield* modeAt("/lists")).toBe("SSR");
      expect(yield* modeAt("/lists/inbox")).toBe("Streamed");
      expect(yield* modeAt("/lists/inbox/print")).toBe("AwaitAll");
      expect(yield* modeAt("/scratch")).toBe("ClientOnly");
    }),
  );
});
