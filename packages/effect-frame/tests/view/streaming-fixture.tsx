/* oxlint-disable effect/noGlobals -- this fixture drives happy-dom's document the way a parser would, the boundary under test. */
import {
  Policies,
  Policy,
  QueryCache,
  Streaming,
  implementQuery,
  query,
  useQuery,
} from "effect-frame/actor";
import type { ActorTransport, QueryFailure, QueryState } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Dom, Html, View } from "effect-frame/view";
import type { Context, Scope } from "effect";
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect";

/**
 * Shared by the streamed-document proofs (#22): one query, a query host whose
 * reads a test holds and releases, a page of readiness boundaries, and the
 * helpers that put a document into happy-dom the way a parser would.
 */

export const Label = query("StreamLabel", {
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ label: Schema.String }),
  policy: "public",
});

/** One side's query host: the labels it answers, the reads it held, the reads it saw. */
export interface Control {
  readonly labels: Map<string, string>;
  readonly gates: Map<string, Deferred.Deferred<void>>;
  readonly calls: Array<string>;
  /** Reads interrupted before they answered: their cache was released. */
  readonly interrupted: Array<string>;
}

export const makeControl = (
  labels: Readonly<Record<string, string>>,
  held: ReadonlyArray<string> = [],
): Control => ({
  labels: new Map(Object.entries(labels)),
  gates: new Map(held.map((id) => [id, Deferred.makeUnsafe<void>()])),
  calls: [],
  interrupted: [],
});

export const release = (control: Control, id: string) =>
  Option.match(Option.fromNullishOr(control.gates.get(id)), {
    onNone: () => Effect.void,
    onSome: (gate) => Effect.asVoid(Deferred.succeed(gate, void 0)),
  });

export type Side = Context.Context<QueryCache | ActorTransport>;

/** The one table the streaming proofs serve: every read is public, by name. */
export const publicPolicies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

/** A real cache over an in-process query host that answers from `control`. */
export const sideOf = (control: Control): Effect.Effect<Side, never, Scope.Scope> =>
  Layer.build(
    QueryTest.layer({
      queries: [
        implementQuery(Label, (args) =>
          Effect.gen(function* () {
            control.calls.push(args.id);
            yield* Option.match(Option.fromNullishOr(control.gates.get(args.id)), {
              onNone: () => Effect.void,
              onSome: Deferred.await,
            }).pipe(
              Effect.onInterrupt(() => Effect.sync(() => void control.interrupted.push(args.id))),
            );
            return {
              label: Option.getOrElse(
                Option.fromNullishOr(control.labels.get(args.id)),
                () => "none",
              ),
            };
          }),
        ),
      ],
    }).pipe(Layer.provide(publicPolicies), Layer.orDie),
  );

export interface PageProps {
  readonly ids: ReadonlyArray<string>;
  /** Ids whose setup waits for the value: they settle while the shell renders. */
  readonly awaited?: ReadonlyArray<string>;
}

/** One readiness boundary per id, then a footer the boundaries must not disturb. */
export const Page = (props: PageProps) =>
  Effect.gen(function* () {
    const scopes = yield* Effect.forEach(props.ids, (id) =>
      View.loading({
        fallback: <p id={`pending-${id}`}>{`loading ${id}`}</p>,
        content: Effect.gen(function* () {
          const entry = yield* useQuery(Label, { id });
          if ((props.awaited ?? []).includes(id)) {
            yield* entry.state.changes.pipe(
              Stream.filter((state) => state._tag !== "Loading"),
              Stream.take(1),
              Stream.runDrain,
            );
          }
          const value = yield* View.ready(entry.state, { label: "?" });
          return <p id={`label-${id}`}>{View.bind(value, (found) => found.label)}</p>;
        }),
      }),
    );
    return (
      <section>
        <h1>labels</h1>
        {scopes}
        <footer id="foot">foot</footer>
      </section>
    );
  });

export const bootstrap = '<script type="module" src="/client.js"></script>';

export const frame: Html.Document = {
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app">',
  tail: "</main>",
  bootstrap,
  end: "</body></html>",
};

/** No time limit: the stream waits for every query. */
export const noLimit: Streaming.ShellOptions = { closeWhen: Effect.never };

/** The streamed document of `ids` over `server`, as its chunks. */
export const streamOf = (
  server: Side,
  ids: ReadonlyArray<string>,
  options: Streaming.ShellOptions = noLimit,
  awaited: ReadonlyArray<string> = [],
): Stream.Stream<string> =>
  // A page of settled boundaries always agrees with its records.
  Html.renderToStream(Page, { ids, awaited }, frame, options).pipe(
    Stream.provideContext(server),
    Stream.orDie,
  );

export const collect = <E,>(stream: Stream.Stream<string, E>) =>
  Effect.map(Stream.runCollect(stream), (chunks) => Array.from(chunks));

// ---------------------------------------------------------------------------
// Reading a document
// ---------------------------------------------------------------------------

export const decodeRecord = Schema.decodeUnknownSync(Streaming.RecordJson);

/** Every record in a document, in document order. */
export const recordsIn = (html: string): ReadonlyArray<Streaming.StreamRecord> =>
  Array.from(
    html.matchAll(/<script type="application\/json" class="frame-record">(.*?)<\/script>/g),
    (match) => decodeRecord(Option.getOrElse(Option.fromNullishOr(match[1]), () => "")),
  );

export const positionOf = (html: string, tag: string, id: string): number =>
  recordsIn(html).findIndex((record) => record._tag === tag && "id" in record && record.id === id);

/**
 * Put a document into happy-dom the way a parser would leave it: the body,
 * without the module script, which a test runs by hand instead.
 */
export const install = (html: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      // A first chunk has no `</body>` yet: its body runs to the end.
      const close = html.lastIndexOf("</body>");
      let end = html.length;
      if (close >= 0) {
        end = close;
      }
      const body = html.slice(html.indexOf("<body>") + "<body>".length, end);
      document.body.innerHTML = body.replace(bootstrap, "");
    }),
    () => Effect.sync(() => void (document.body.innerHTML = "")),
  );

/** The parser is still reading the document: `readyState` says so until `finishParsing`. */
export const parsing = Effect.acquireRelease(
  Effect.sync(() => {
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
  }),
  () => Effect.sync(() => void Reflect.deleteProperty(document, "readyState")),
);

export const finishParsing = Effect.sync(() => {
  Reflect.deleteProperty(document, "readyState");
  document.dispatchEvent(new Event("DOMContentLoaded"));
});

/** Append one record to the container, as the parser appends a streamed chunk. */
export const append = (record: Streaming.StreamRecord) =>
  Effect.sync(() => {
    Option.map(Option.fromNullishOr(document.getElementById(Streaming.containerId)), (container) =>
      container.insertAdjacentHTML("beforeend", Html.streamRecord(record)),
    );
  });

export const textOf = (selector: string): string =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(document.querySelector(selector)), (node) =>
      Option.fromNullishOr(node.textContent),
    ),
    () => "",
  );

export const present = (selector: string): boolean =>
  Option.isSome(Option.fromNullishOr(document.querySelector(selector)));

/** Poll a DOM condition with the real clock. */
export const eventually = (label: string, check: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (check()) {
        return;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(`timed out waiting for ${label}`);
  });

/** Poll an Effect condition with the real clock. */
export const eventuallyEffect = (label: string, check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(`timed out waiting for ${label}`);
  });

/** The host and root a hydrating client mounts into. */
export type Mounting = (
  host: Dom.Hydration["host"],
  root: HTMLElement,
) => Effect.Effect<unknown, never, QueryCache | ActorTransport | Scope.Scope>;

/** The client: read the records, seed the cache, hydrate `#app` with `mounting`, then run `Resumed.hydrated`. */
export const hydrateWith = (client: Side, mounting: Mounting) =>
  Effect.gen(function* () {
    const root = Option.getOrThrow(
      Option.filter(
        Option.fromNullishOr(document.getElementById("app")),
        (found): found is HTMLElement => found instanceof HTMLElement,
      ),
    );
    const records = yield* Dom.readRecords;
    const resumed = yield* Streaming.resume(records);
    const hydration = Dom.hydrate(root);
    yield* mounting(hydration.host, root);
    yield* View.flush;
    const report = yield* hydration.finish;
    // As the documented client does: a read a seed calls for starts now.
    yield* resumed.hydrated;
    return { report, resumed, root };
  }).pipe(Effect.provideContext(client));

/** The client: read the records, seed the cache, hydrate `#app` with `Page`. */
export const hydrateClient = (
  client: Side,
  ids: ReadonlyArray<string>,
  awaited: ReadonlyArray<string> = [],
) => hydrateWith(client, (host, root) => View.mount(Page, { ids, awaited }, host, root));

/** The client cache's state for one id, through the entry the view declared. */
export const stateOf = (client: Side, id: string) =>
  Effect.gen(function* () {
    const cache = yield* QueryCache;
    const entry = yield* cache.open(Label, { id });
    return yield* entry.state.get;
  }).pipe(Effect.scoped, Effect.provideContext(client));

export const valueRecord = (id: string, label: string): Streaming.Patch => ({
  _tag: "Patch",
  id,
  outcome: { _tag: "Value", value: JSON.stringify({ label }) },
});

/** A patch as the server writes it after its shell, which drew the entry open. */
export const lateRecord = (id: string, label: string): Streaming.Patch => ({
  ...valueRecord(id, label),
  late: true,
});

export const idOf = (id: string): string =>
  Streaming.recordId({ query: Label.name, version: Label.version, args: JSON.stringify({ id }) });

export const isStreamEnded = (
  state: QueryState<{ readonly label: string }, QueryFailure>,
): boolean => state._tag === "Failed" && state.error._tag === "StreamEnded";

// ---------------------------------------------------------------------------
// Records that move inside the final pass (review round 2)
// ---------------------------------------------------------------------------

/** What `Moving` does each time its second binding is read. */
export interface Mover {
  on: boolean;
  moves: number;
}

const shownState = (state: QueryState<{ readonly label: string }, QueryFailure>): string => {
  if (state._tag === "Ready") {
    return `${state.value.label}:${String(state.stale)}`;
  }
  return state._tag;
};

/**
 * `a`'s state, then a binding that, once `mover.on` is set, writes a new
 * value to `a` each time it is read. A catch-up draws `a` first and then
 * reads that binding, so the records read after it hold a value the
 * drawing does not show, and the reads never agree. The boundary over
 * `held` keeps its fallback while `held` is held, so an `AwaitAll` render
 * waits for the limit.
 */
export const Moving = (props: { readonly mover: Mover }) =>
  Effect.gen(function* () {
    const entry = yield* useQuery(Label, { id: "a" });
    // `a`'s binding moves only when a catch-up reads it: it stands for a
    // binding whose change is still on its way through its fiber.
    const lagging = { get: entry.state.get, changes: Stream.never };
    const moved = {
      get: Effect.gen(function* () {
        if (props.mover.on) {
          props.mover.moves += 1;
          yield* entry.override(() => ({ label: `Draft-${String(props.mover.moves)}` }));
        }
        return "moved";
      }),
      changes: Stream.never,
    };
    const held = yield* View.loading({
      fallback: <p id="held-pending">loading</p>,
      content: Effect.gen(function* () {
        const found = yield* useQuery(Label, { id: "held" });
        const value = yield* View.ready(found.state, { label: "?" });
        return <p id="held">{View.bind(value, (one) => one.label)}</p>;
      }),
    });
    return (
      <section>
        <p id="state">{View.bind(lagging, shownState)}</p>
        <i>{View.bind(moved, (text) => text)}</i>
        {held}
      </section>
    );
  });
