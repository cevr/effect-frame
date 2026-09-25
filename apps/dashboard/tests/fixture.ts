import type { Route, LocationService } from "effect-frame/router";
import type { AnyQueryImplementation } from "effect-frame/actor";
import type { QueryKey, Refreshed, TransportService } from "effect-frame/actor/client";
import {
  ActorTransport,
  Authenticated,
  CurrentPrincipal,
  QueryFailed,
  QueryCache,
} from "effect-frame/actor/client";
import { Location, mount, NavigationBehavior } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { Context, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { hostWith } from "../src/host.server.js";
import { ScanTime, queries } from "../src/queries.server.js";
import { NotFound } from "../src/views.js";

/**
 * What the Dashboard tests share: the real host, wrapped twice. The query
 * handlers are the app's own, each behind a tap that counts its runs and
 * can hold or fail one; the transport the page talks to is the host's own,
 * behind a wiretap that records every command's active keys and the
 * refreshes its reply carried. Nothing is mocked: a held or failed read is
 * the real handler, waiting or refused.
 */

// ---------------------------------------------------------------------------
// The member
// ---------------------------------------------------------------------------

/** The principal the fixture header names on the HTTP path (`server.ts`). */
export const member = (...tenants: ReadonlyArray<string>) =>
  Authenticated.make({ subject: `member:${tenants.join(",")}`, claims: { tenants: [...tenants] } });

/**
 * An in-process transport serves the caller's principal. The page's calls
 * run in the page's fibers, so the member is provided on every verb, as the
 * HTTP server provides the one its header names.
 */
const asMember = (inner: TransportService, principal: Authenticated): TransportService => ({
  send: (...args) => Effect.provideService(inner.send(...args), CurrentPrincipal, principal),
  call: (...args) => Effect.provideService(inner.call(...args), CurrentPrincipal, principal),
  snapshot: (address) =>
    Effect.provideService(inner.snapshot(address), CurrentPrincipal, principal),
  query: (key) => Effect.provideService(inner.query(key), CurrentPrincipal, principal),
  queryBatch: (keys) => Effect.provideService(inner.queryBatch(keys), CurrentPrincipal, principal),
  changes: (address, after) =>
    Stream.provideService(inner.changes(address, after), CurrentPrincipal, principal),
});

// ---------------------------------------------------------------------------
// A tap on the query handlers
// ---------------------------------------------------------------------------

/**
 * The app's handlers, each behind a tap. Every run is counted by query
 * name, whether a client read it or a command reply refreshed it: a handler
 * that did not run did no work. A test may hold every run of one query, or
 * fail it as a throwing handler would. `Slowest` scans for no time here; a
 * test that wants it slow holds it.
 */
export const tapHandlers = () => {
  const runs = new Map<string, number>();
  const held = new Map<string, Deferred.Deferred<void>>();
  const failing = new Set<string>();
  const tap = (implementation: AnyQueryImplementation<never>): AnyQueryImplementation<never> => {
    if (implementation.mode === "batched") {
      return implementation;
    }
    const name = implementation.contract.name;
    return {
      ...implementation,
      run: (args) =>
        Effect.gen(function* () {
          runs.set(name, (runs.get(name) ?? 0) + 1);
          const gate = Option.fromNullishOr(held.get(name));
          if (Option.isSome(gate)) {
            yield* Deferred.await(gate.value);
          }
          if (failing.has(name)) {
            return yield* QueryFailed.make({ query: name, detail: `${name} store is down` });
          }
          return yield* implementation.run(args);
        }).pipe(Effect.provideService(ScanTime, 0)),
    };
  };
  return {
    served: queries.map(tap),
    /** How many times the handler of `name` ran. */
    runsOf: (name: string): number => runs.get(name) ?? 0,
    /** Every handler's run count, by name. */
    runs: (): ReadonlyMap<string, number> => new Map(runs),
    /** Hold every run of `name` until the gate opens. */
    hold: (name: string) =>
      Effect.tap(Deferred.make<void>(), (gate) => Effect.sync(() => void held.set(name, gate))),
    /** Fail every run of `name` with the handler's own `QueryFailed`. */
    fail: (name: string) => Effect.sync(() => void failing.add(name)),
    heal: (name: string) => Effect.sync(() => void failing.delete(name)),
  };
};

export type Handlers = ReturnType<typeof tapHandlers>;

// ---------------------------------------------------------------------------
// A wiretap on the transport
// ---------------------------------------------------------------------------

/** A query key as the tests name it: `Revenue{"tenant":"acme"}`. */
export const keyText = (key: QueryKey): string => `${key.query}${key.args}`;

const refreshedText = (refreshed: ReadonlyArray<Refreshed>): ReadonlyArray<string> =>
  refreshed.map((one) => keyText(one.key)).toSorted();

const Tagged = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.String, id: Schema.optionalKey(Schema.String) }),
);
const decodeTagged = Schema.decodeUnknownOption(Tagged);

/** A message as the tests name it: `Fulfil o6`, `Write`. */
const labelOf = (payload: string): string =>
  Option.match(decodeTagged(payload), {
    onNone: () => "?",
    onSome: (message) =>
      Option.match(Option.fromNullishOr(message.id), {
        onNone: () => message._tag,
        onSome: (id) => `${message._tag} ${id}`,
      }),
  });

/** One command as the wire saw it: the keys it declared and the keys its reply refreshed. */
export interface Sighting {
  /**
   * `send` admits the command and declares nothing; `call` waits for its
   * commit and declares the page's keys, so its reply is the one that
   * carries the refreshes (#17, `command-owner.ts`).
   */
  readonly verb: "send" | "call";
  readonly contract: string;
  readonly label: string;
  readonly active: ReadonlyArray<string>;
  readonly refreshed: ReadonlyArray<string>;
  /** The refreshes that came back failed, by key. */
  readonly failed: ReadonlyArray<string>;
  /**
   * The revision the command committed: a `send` receipt's, when admission
   * already committed it, and the projection a `call` settled on.
   */
  readonly committed: Option.Option<number>;
}

/**
 * The real transport, watched and steered. A held send waits for its gate
 * before the host sees it; a held snapshot read waits before the host is
 * asked. Every client read of a query is recorded by key.
 */
export const wiretap = (inner: TransportService) => {
  const reads: Array<string> = [];
  const snapshots: Array<string> = [];
  const streams: Array<string> = [];
  const failedSends: Array<string> = [];
  const commands: Array<Sighting> = [];
  const heldSends = new Map<string, Deferred.Deferred<void>>();
  const heldSnapshots = new Map<string, Deferred.Deferred<void>>();
  const pass = (gate: Option.Option<Deferred.Deferred<void>>) =>
    Option.match(gate, { onNone: () => Effect.void, onSome: Deferred.await });
  const sighting = (
    verb: Sighting["verb"],
    contract: string,
    label: string,
    active: ReadonlyArray<QueryKey>,
    refreshed: ReadonlyArray<Refreshed>,
    committed: Option.Option<number>,
  ): Sighting => ({
    verb,
    contract,
    committed,
    label,
    active: active.map(keyText).toSorted(),
    refreshed: refreshedText(refreshed),
    failed: refreshed
      .filter((one) => one._tag === "RefreshFailed")
      .map((one) => keyText(one.key))
      .toSorted(),
  });
  const transport: TransportService = {
    ...inner,
    changes: (address, after) =>
      Stream.unwrap(
        Effect.sync(() => {
          streams.push(`${address.contract}${address.key}`);
          return inner.changes(address, after);
        }),
      ),
    snapshot: (address) =>
      Effect.gen(function* () {
        snapshots.push(`${address.contract}${address.key}`);
        yield* pass(Option.fromNullishOr(heldSnapshots.get(address.contract)));
        return yield* inner.snapshot(address);
      }),
    query: (key) =>
      Effect.andThen(
        Effect.sync(() => void reads.push(keyText(key))),
        inner.query(key),
      ),
    send: (address, commandId, payload, active) =>
      Effect.gen(function* () {
        const label = labelOf(payload);
        yield* pass(Option.fromNullishOr(heldSends.get(label)));
        const reply = yield* Effect.tapError(inner.send(address, commandId, payload, active), () =>
          Effect.sync(() => void failedSends.push(label)),
        );
        commands.push(
          sighting(
            "send",
            address.contract,
            label,
            active,
            reply.refreshed,
            reply.receipt.committed,
          ),
        );
        return reply;
      }),
    call: (address, commandId, payload, timeout, active) =>
      Effect.gen(function* () {
        const reply = yield* inner.call(address, commandId, payload, timeout, active);
        commands.push(
          sighting(
            "call",
            address.contract,
            labelOf(payload),
            active,
            reply.refreshed,
            Option.some(reply.projection.revision),
          ),
        );
        return reply;
      }),
  };
  const gate = (table: Map<string, Deferred.Deferred<void>>, name: string) =>
    Effect.tap(Deferred.make<void>(), (held) => Effect.sync(() => table.set(name, held)));
  return {
    transport,
    reads,
    snapshots,
    /** Every change stream the client opened, by actor address. */
    streams,
    /** Every send the host answered with a failure, a refusal among them, by label. */
    failedSends,
    commands,
    /** Hold the send whose message reads `label` (`Fulfil o6`) until the gate opens. */
    holdSend: (label: string) => gate(heldSends, label),
    /** Hold every snapshot read of the contract `name` until the gate opens. */
    holdSnapshot: (name: string) => gate(heldSnapshots, name),
    open: (held: Deferred.Deferred<void>) => Deferred.succeed(held, void 0),
    /** How many times the client read this key. */
    readsOf: (key: string) => reads.filter((one) => one === key).length,
    /** Every request whose message reads `label`, in order. */
    sightingsOf: (label: string) => commands.filter((one) => one.label === label),
    /** The one settling request of the command whose message reads `label`. */
    settlementsOf: (label: string) =>
      commands.filter((one) => one.label === label && one.verb === "call"),
  };
};

export type Wiretap = ReturnType<typeof wiretap>;

/**
 * The real host over tapped handlers, served to `principal`, behind a
 * wiretap. The member of `acme` by default.
 */
export const tappedHost = (principal: Authenticated = member("acme")) =>
  Effect.gen(function* () {
    const handlers = tapHandlers();
    const host = yield* Layer.build(hostWith(handlers.served));
    const wire = wiretap(asMember(Context.get(host, ActorTransport), principal));
    return { handlers, wire };
  });

// ---------------------------------------------------------------------------
// The app mounted in happy-dom
// ---------------------------------------------------------------------------

/** Put a server document, or an empty one, into happy-dom. */
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

/**
 * Mount the route tree into a fresh `#app` in happy-dom, over one client:
 * its own query cache over `transport`. `run` provides that client, so a
 * test can read the cache as the page would.
 */
export const mountApp = Effect.fn("test.mountApp")(function* <R>(options: {
  readonly transport: TransportService;
  readonly href: string;
  readonly routes: ReadonlyArray<Route.AnyRoute<R>>;
}) {
  const root = yield* install('<body><main id="app"></main></body>');
  const client = yield* Layer.build(
    Layer.provideMerge(QueryCache.layer, Layer.succeed(ActorTransport, options.transport)),
  );
  const { location, current } = yield* locationAt(options.href);
  const router = yield* mount({
    landing: NavigationBehavior.Restore,
    traversalReadLimit: "3 seconds",
    routes: options.routes,
    notFound: NotFound,
    host: Dom.host,
    root,
  }).pipe(Effect.provideService(Location, location), Effect.provideContext(client));
  yield* View.flush;
  const run = <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
  ): Effect.Effect<A, E, Exclude<R2, QueryCache | ActorTransport>> =>
    Effect.provideContext(effect, client);
  return { root, router, current, run };
});

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

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
  yield* Effect.repeat(Effect.andThen(Effect.sleep("25 millis"), View.flush), {
    while: () => Effect.map(check, (done) => !done),
    times: 80,
  });
  if (!(yield* check)) {
    return yield* Effect.die(new Error(`settle: ${what} never held`));
  }
});

/** Click the element `selector` names, as a reader does. */
export const click = (root: ParentNode, selector: string) =>
  Effect.sync(() => {
    const found = Option.getOrThrowWith(
      Option.fromNullishOr(root.querySelector(selector)),
      () => `no ${selector}`,
    );
    found.dispatchEvent(new Event("click", { bubbles: true }));
  });

/** Submit the form `selector` names, as a reader pressing Enter does. */
export const submit = (root: ParentNode, selector: string) =>
  Effect.sync(() => {
    const found = Option.getOrThrowWith(
      Option.fromNullishOr(root.querySelector(selector)),
      () => `no ${selector}`,
    );
    found.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
