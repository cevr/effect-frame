import { platformFetch } from "./dom-setup.js";

import type {
  QueryCache,
  QueryFailure,
  QueryKey,
  Refreshed,
  Refused,
  TransportService,
  Unauthorized,
} from "effect-frame/actor/client";
import { ActorTransport, HttpTransport, queryCacheLayer } from "effect-frame/actor/client";
import { Location, mount } from "effect-frame/router";
import type { AnyRoute, LocationService } from "effect-frame/router";
import { Dom, render } from "effect-frame/view";
import { Context, Deferred, Effect, Layer, Option, Predicate, Ref, Schema, Stream } from "effect";
import { hydrateApp } from "../src/app.js";
import { NotFound } from "../src/views.js";
import { inProcess } from "../src/notes.server.js";
import type { NotesRuntime, RunningServer } from "../src/server.js";
import { makeRuntime, makeServer } from "../src/server.js";

/**
 * What the Notes tests share: one real server on a free port, the client
 * services pointed at it, and a page installed into happy-dom the way a
 * browser receives it. Nothing here is mocked; a test that holds or fails a
 * call wraps the transport it is given.
 */

/** happy-dom replaces `fetch`; the actor transport needs the real one. */
const realFetch: HttpTransport.FetchLike = (input, init) => platformFetch(input, init);

export const transportTo = (url: string): Layer.Layer<ActorTransport> =>
  HttpTransport.layer({
    baseUrl: `${url}/actors`,
    reconnect: HttpTransport.defaultReconnect,
  }).pipe(Layer.provide(Layer.succeed(HttpTransport.Fetch, realFetch)));

/** The browser's services over `transport`: the query cache and the transport. */
export const clientServices = (
  transport: Layer.Layer<ActorTransport>,
): Layer.Layer<QueryCache | ActorTransport> => Layer.provideMerge(queryCacheLayer, transport);

/**
 * One client of the test: its own query cache and transport, built in the
 * test's Scope so they live as long as what it mounts. A server's port is
 * known only once it listens, so the services cannot be the test's outer
 * layer; this is the client's entry point instead, and the only place they
 * are provided. Two calls are two tabs.
 */
export const clientOf = Effect.fn("test.clientOf")(function* (
  url: string,
  transport: Layer.Layer<ActorTransport> = transportTo(url),
) {
  const services = yield* Layer.build(clientServices(transport));
  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, QueryCache | ActorTransport>> =>
    Effect.provideContext(effect, services);
});

/** One host for the whole test: two servers over it share one set of actors. */
export const notesRuntime = Effect.acquireRelease(
  Effect.sync((): NotesRuntime => makeRuntime(inProcess)),
  (runtime) => Effect.promise(() => runtime.dispose()),
);

export const serve = (runtime: NotesRuntime, port = 0) =>
  Effect.acquireRelease(
    Effect.promise((): Promise<RunningServer> => makeServer({ port, runtime })),
    (server) => Effect.promise(() => server.stop()),
  );

/** A runtime and a server on a free port, both released with the test. */
export const serveFresh = Effect.flatMap(notesRuntime, (runtime) => serve(runtime));

export const fetchPage = Effect.fn("test.fetchPage")(function* (url: string) {
  const response = yield* Effect.promise(() => platformFetch(url, { redirect: "manual" }));
  const text = yield* Effect.promise(() => response.text());
  return { status: response.status, headers: response.headers, text };
});

export const fetchText = (url: string) => Effect.map(fetchPage(url), (page) => page.text);

/**
 * Put a server document into happy-dom as a browser would have parsed it:
 * the whole body, records and seed included, without the module script.
 */
export const install = (page: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const body = page.slice(page.indexOf("<body>") + "<body>".length, page.indexOf("</body>"));
      document.body.innerHTML = body.replace(
        '<script type="module" src="/client.js"></script>',
        "",
      );
      return Option.getOrElse(Option.fromNullishOr(document.getElementById("app")), () =>
        document.createElement("main"),
      );
    }),
    () => Effect.sync(() => void (document.body.innerHTML = "")),
  );

/** A Location that starts at `href`, and moves when the router moves it. */
export const locationAt = (href: string) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(href));
    const location: LocationService = {
      current: Ref.get(current),
      push: (url) => Ref.set(current, url),
      replace: (url) => Ref.set(current, url),
      pops: Stream.never,
    };
    return { location, current: Ref.get(current) };
  });

/** Hydrate the installed page at `href`, as `client.tsx` does. */
export const hydrateAt = Effect.fn("test.hydrateAt")(function* (root: HTMLElement, href: string) {
  const { location } = yield* locationAt(href);
  return yield* Effect.provideService(hydrateApp(root), Location, location);
});

export const textOf = (root: ParentNode, selector: string): string =>
  Option.match(Option.fromNullishOr(root.querySelector(selector)), {
    onNone: () => "",
    onSome: (node) => Option.getOrElse(Option.fromNullishOr(node.textContent), () => ""),
  });

export const has = (root: ParentNode, selector: string): boolean =>
  Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

/**
 * Flush and poll until `check` holds, for at most two seconds. A check that
 * never holds is a defect naming `what`, so a wait can never pass silently.
 */
export const settle = Effect.fn("test.settle")(function* (
  check: Effect.Effect<boolean>,
  what = "the awaited state",
) {
  yield* Effect.repeat(Effect.andThen(Effect.sleep("25 millis"), render), {
    while: () => Effect.map(check, (done) => !done),
    times: 80,
  });
  if (!(yield* check)) {
    return yield* Effect.die(new Error(`settle: ${what} never held`));
  }
});

/** The element `selector` names, as `type`, or a defect naming it. */
export const elementOf = <T extends Element>(
  root: ParentNode,
  selector: string,
  type: abstract new (...args: never) => T,
): T =>
  Option.getOrThrowWith(
    Option.filter(
      Option.fromNullishOr(root.querySelector(selector)),
      (found): found is T => found instanceof type,
    ),
    () => `no ${selector}`,
  );

// ---------------------------------------------------------------------------
// A wiretap on the transport
// ---------------------------------------------------------------------------

/** A query key as the tests name it: `ListCounts{"list":"inbox"}`. */
export const keyText = (key: QueryKey): string => `${key.query}${key.args}`;

const refreshedText = (refreshed: ReadonlyArray<Refreshed>): ReadonlyArray<string> =>
  refreshed.map((one) => keyText(one.key)).toSorted();

const MessageText = Schema.fromJsonString(
  Schema.Struct({ text: Schema.optionalKey(Schema.String) }),
);
const textOf_ = (payload: string): string =>
  Option.getOrElse(
    Option.flatMap(Schema.decodeUnknownOption(MessageText)(payload), (message) =>
      Option.fromNullishOr(message.text),
    ),
    () => "",
  );

/** One command as the wire saw it: the keys it declared and the keys its reply refreshed. */
export interface Sighting {
  readonly verb: "send" | "call";
  readonly text: string;
  readonly active: ReadonlyArray<string>;
  readonly refreshed: ReadonlyArray<string>;
}

/**
 * The real transport, watched and steered. Every verb reaches the real host
 * unless the test says otherwise: a held send or query waits for its gate,
 * and a failing query fails before the host sees it. A send the host
 * refuses is recorded with the host's own `Refused` or `Unauthorized`.
 */
/** A send the host refused: its behavior (`Refused`) or its policy (`Unauthorized`). */
const isHostRefusal = Predicate.or(
  Predicate.isTagged("Refused"),
  Predicate.isTagged("Unauthorized"),
);

export const wiretap = (inner: TransportService) => {
  const reads: Array<string> = [];
  const snapshots: Array<string> = [];
  const commands: Array<Sighting> = [];
  const heldSends = new Map<string, Deferred.Deferred<void>>();
  const heldQueries = new Map<string, Deferred.Deferred<void>>();
  const failing = new Map<string, QueryFailure>();
  const refusals: Array<{ readonly text: string; readonly reason: Refused | Unauthorized }> = [];
  const pass = (gate: Option.Option<Deferred.Deferred<void>>) =>
    Option.match(gate, { onNone: () => Effect.void, onSome: Deferred.await });
  const read = (key: QueryKey) =>
    Effect.gen(function* () {
      reads.push(keyText(key));
      yield* pass(Option.fromNullishOr(heldQueries.get(key.query)));
      const failure = Option.fromNullishOr(failing.get(key.query));
      if (Option.isSome(failure)) {
        return yield* failure.value;
      }
      return yield* inner.query(key);
    });
  const transport: TransportService = {
    ...inner,
    snapshot: (address) =>
      Effect.andThen(
        Effect.sync(() => void snapshots.push(`${address.contract}${address.key}`)),
        inner.snapshot(address),
      ),
    query: read,
    queryBatch: (keys) => Effect.andThen(Effect.forEach(keys, read), inner.queryBatch(keys)),
    send: (address, commandId, payload, active) =>
      Effect.gen(function* () {
        const text = textOf_(payload);
        yield* pass(Option.fromNullishOr(heldSends.get(text)));
        const reply = yield* inner.send(address, commandId, payload, active).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (isHostRefusal(error)) {
                refusals.push({ text, reason: error });
              }
            }),
          ),
        );
        commands.push({
          verb: "send",
          text,
          active: active.map(keyText).toSorted(),
          refreshed: refreshedText(reply.refreshed),
        });
        return reply;
      }),
    call: (address, commandId, payload, timeout, active) =>
      Effect.gen(function* () {
        const text = textOf_(payload);
        const reply = yield* inner.call(address, commandId, payload, timeout, active);
        commands.push({
          verb: "call",
          text,
          active: active.map(keyText).toSorted(),
          refreshed: refreshedText(reply.refreshed),
        });
        return reply;
      }),
  };
  const gate = (table: Map<string, Deferred.Deferred<void>>, name: string) =>
    Effect.tap(Deferred.make<void>(), (held) => Effect.sync(() => table.set(name, held)));
  return {
    transport,
    reads,
    /** Every actor snapshot read, as `Notes{"list":…,"tenant":…}`, in order. */
    snapshots,
    commands,
    /** The sends the real host refused (its behavior or its policy), with its reason, in order. */
    refusals,
    /** Hold the send of a note with this text until the gate opens. */
    holdSend: (text: string) => gate(heldSends, text),
    /** Hold every read of this query until the gate opens. */
    holdQuery: (name: string) => gate(heldQueries, name),
    open: (held: Deferred.Deferred<void>) => Deferred.succeed(held, void 0),
    fail: (name: string, failure: QueryFailure) =>
      Effect.sync(() => void failing.set(name, failure)),
    heal: (name: string) => Effect.sync(() => void failing.delete(name)),
    /** How many times this key was read. */
    readsOf: (key: string) => reads.filter((one) => one === key).length,
    /** How many times any key of the query `name` was read. */
    readsNamed: (name: string) => reads.filter((one) => one.startsWith(`${name}{`)).length,
  };
};

export type Wiretap = ReturnType<typeof wiretap>;

/** The in-memory host, with a wiretap on its transport. */
export const tappedHost = Effect.gen(function* () {
  const host = yield* Layer.build(inProcess);
  return wiretap(Context.get(host, ActorTransport));
});

// ---------------------------------------------------------------------------
// The app mounted in happy-dom
// ---------------------------------------------------------------------------

/**
 * Mount the route tree into a fresh `#app` in happy-dom, over one client:
 * its own query cache over `transport`. `run` provides that client, so a
 * test can open a reference or read the cache as the page would.
 */
export const mountApp = Effect.fn("test.mountApp")(function* <R>(options: {
  readonly transport: TransportService;
  readonly href: string;
  readonly routes: ReadonlyArray<AnyRoute<R>>;
}) {
  const root = yield* install('<body><main id="app"></main></body>');
  const client = yield* Layer.build(
    clientServices(Layer.succeed(ActorTransport, options.transport)),
  );
  const { location, current } = yield* locationAt(options.href);
  const router = yield* mount({
    routes: options.routes,
    notFound: NotFound,
    host: Dom.host,
    root,
  }).pipe(Effect.provideService(Location, location), Effect.provideContext(client));
  yield* render;
  const run = <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
  ): Effect.Effect<A, E, Exclude<R2, QueryCache | ActorTransport>> =>
    Effect.provideContext(effect, client);
  return { root, router, current, run };
});
