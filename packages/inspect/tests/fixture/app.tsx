/* oxlint-disable effect/noGlobals, effect/noNewPromise, effect/noNewError -- this module is the fixture's browser boundary: it reads page config and exposes test controls on window. */
/**
 * A production-shaped application root for the transport proof. It mirrors
 * the EGW browser entry: one `Frame.layer`, the real query cache (QueryTest's
 * local host), the browser Location, and one routed mount. The only test
 * seams are on `window.__fixture`: a gate that holds the query resolver, a
 * direct read of the same Frame service, and root close.
 */
import {
  Actor,
  Behavior,
  Policies,
  Policy,
  implementQuery,
  query,
  QueryCache,
} from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import * as Frame from "effect-frame/frame";
import { Location, Route, browserLocation, mount } from "effect-frame/router";
import type { Source } from "effect-frame/actor";
import { Dom, Await, View } from "effect-frame/view";
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";
// @ts-expect-error Effect keeps this scope counter runtime-only; the proof checks root scope growth.
import { scopeFinalizerCountUnsafe } from "../../../../node_modules/effect/dist/internal/effect.js";

export const HeldQuery = query("InspectionGatewayHeld", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.String,
  depends: [],
});

export interface FixtureConfig {
  readonly name: string;
  readonly gateway?: { readonly url: string; readonly token: string };
}

export interface FixtureWindow {
  readonly config: FixtureConfig;
  readonly startedAt: number;
  mountedAt: number;
  resolverStarts: number;
  resolverFinished: number;
  closed: boolean;
  readonly status: Array<unknown>;
  release: () => void;
  inspect: () => Promise<string>;
  close: () => Promise<void>;
  finalizers: () => number;
  busy: (millis: number) => void;
}

declare global {
  interface Window {
    __fixture: FixtureWindow;
    __fixtureConfig: FixtureConfig;
    __sockets: { created: number; all: Array<WebSocket> };
    __openSockets: () => number;
  }
}

const encodeSnapshot = Schema.encodeSync(Frame.Snapshot);

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

const BookParams = Schema.Struct({ id: Schema.String });

/**
 * Start the application root. `inspection` is the application boundary's
 * opt-in: the production entry passes nothing, the development entry passes
 * the attachment.
 */
export const start = (
  inspection: (
    config: FixtureConfig,
    status: Array<unknown>,
  ) => Effect.Effect<void, never, Frame.Service | Scope.Scope>,
): void => {
  const config = window.__fixtureConfig;
  const gate = Deferred.makeUnsafe<void>();
  const fixture: FixtureWindow = {
    config,
    startedAt: performance.now(),
    mountedAt: 0,
    resolverStarts: 0,
    resolverFinished: 0,
    closed: false,
    status: [],
    release: () => {
      Effect.runSync(Deferred.succeed(gate, void 0));
    },
    inspect: () => Promise.reject(new Error("root is not running")),
    close: () => Promise.resolve(),
    finalizers: () => -1,
    busy: (millis) => {
      const until = performance.now() + millis;
      while (performance.now() < until) {
        // Hold the page's only thread so socket frames queue behind it.
      }
    },
  };
  window.__fixture = fixture;

  const HeldLive = implementQuery(HeldQuery, {
    run: ({ id }) =>
      Effect.gen(function* () {
        fixture.resolverStarts += 1;
        yield* Deferred.await(gate);
        fixture.resolverFinished += 1;
        return `book ${id}`;
      }),
  });

  const bookSegment = Route.segment("book", {
    path: "/books/:id",
    params: BookParams,
    search: Route.search(Schema.Struct({})),
  });
  const book = Route.client(
    "book",
    Route.leaf(bookSegment, (props) =>
      Effect.gen(function* () {
        const local = yield* Actor.local(Behavior.value("local"));
        const id = yield* props.params.get;
        const held = yield* View.loading({
          fallback: <p id="loading">loading</p>,
          content: Effect.gen(function* () {
            const entry = yield* QueryCache.use((cache) => cache.open(HeldQuery, { id: id.id }));
            yield* View.readyWithStale(entry.state, "");
            return (
              <Await
                state={entry.state}
                loading={<p id="query-loading">query-loading</p>}
                ready={(value) => <p id="result">{View.bind(value)}</p>}
                failed={() => <p id="failed">failed</p>}
              />
            );
          }),
        });
        return (
          <section>
            <output id="actor">{View.bind(local.state, String)}</output>
            {held}
          </section>
        );
      }),
    ),
  );

  const services = Layer.mergeAll(
    QueryTest.layer({ queries: [HeldLive] }).pipe(
      Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
      Layer.provideMerge(Frame.layer({ name: config.name })),
    ),
    Layer.succeed(Location, browserLocation),
  );

  const main = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<Frame.Service>();
    // A direct read of the same service the attachment reads.
    fixture.inspect = () =>
      Effect.runPromiseWith(context)(Frame.inspect).then((snapshot) =>
        JSON.stringify(encodeSnapshot(snapshot)),
      );
    fixture.finalizers = () => scopeFinalizerCountUnsafe(scope);
    // The opt-in runs before mount so the proof sees any delay it causes.
    yield* inspection(config, fixture.status);
    const found = Option.fromNullishOr(document.getElementById("root"));
    if (Option.isNone(found)) {
      return yield* Effect.die("fixture: no #root element");
    }
    yield* mount({ routes: [book], notFound: NotFound, host: Dom.host, root: found.value });
    fixture.mountedAt = performance.now();
    return yield* Effect.never;
  });

  // This is the application entry point: the one place services are provided.
  // @effect-diagnostics-next-line strictEffectProvide:off
  const fiber = Effect.runFork(Effect.scoped(Effect.provide(main, services)));
  fixture.close = () =>
    Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      fixture.closed = true;
    });
};
