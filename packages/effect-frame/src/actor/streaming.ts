import type { Scope } from "effect";
import { Deferred, Effect, Filter, Match, Option, Schema, Stream } from "effect";
import type { QueryFailure as QueryFailureType, QueryKey, QueryState } from "./query.js";
import { Failed, QueryFailure, Ready, keyOf } from "./query.js";
import type { DocumentAccess, DocumentEntry } from "./query-client.js";
import { QueryCache, documentOf } from "./query-client.js";

/**
 * Streamed documents (#22). A streamed response writes the shell, then one
 * JSON record per event, in the order the events happen. No record runs as
 * script: the client reads the records the parser has appended and watches
 * for the rest. See `docs/design/streaming.md`.
 *
 * The records address the query cache, and the cache is keyed by the query
 * key, so a record's id is that key. Both sides derive it from the contract
 * and the encoded arguments. Nothing is counted, so a client that renders
 * its scopes in another order still addresses the same entries.
 *
 * This module is client-safe. The server half reads the cache it is given;
 * it never imports a host or a handler.
 */

/** Where a streamed value lives in the document. Derived, never allocated. */
export type RecordId = string;

/** The id of one query's records: its cache key, `keyOf(key)`. */
export const recordId = (key: QueryKey): RecordId => keyOf(key);

/** The element that holds every record of a streamed document. */
export const containerId = "frame-records";

/** The class each record script carries inside the container. */
export const recordClass = "frame-record";

/**
 * The script an `AwaitAll` document writes instead of the record channel:
 * every query's settled value, as one JSON array of `Patch` records.
 */
export const seedId = "frame-query-seed";

/**
 * A slot the server has opened and not yet filled. Written for every entry
 * the shell declared, always before any patch that addresses it.
 */
export const Placeholder = Schema.TaggedStruct("Placeholder", {
  id: Schema.String,
  kind: Schema.Literal("query"),
});
export type Placeholder = Schema.Schema.Type<typeof Placeholder>;

/** A settled value, still encoded: the client decodes it through its own contract. */
export const ValueOutcome = Schema.TaggedStruct("Value", { value: Schema.String });

/** A settled failure, in the client-safe failure union. */
export const ErrorOutcome = Schema.TaggedStruct("Error", { error: QueryFailure });

/** The settle. One per placeholder, at most once; a second one changes nothing. */
export const Patch = Schema.TaggedStruct("Patch", {
  id: Schema.String,
  outcome: Schema.Union([ValueOutcome, ErrorOutcome]),
  /**
   * Present only on a prerendered page (#23 §3.2): when the build read this
   * value, in milliseconds since the epoch. Its presence is what seeds the
   * entry `Ready{stale: true}`, so the client reads it again once hydration
   * is done (`Resumed.hydrated`). Nothing branches on its value.
   */
  builtAt: Schema.optionalKey(Schema.Finite),
  /**
   * Present only when the server showed the value stale: a read, a refresh
   * or a command that the value waits for was still open, or the value was
   * set by `override`. The server drawing shows the flag, so the client
   * seeds the entry `Ready{stale: true}` too, and reads it again once
   * hydration is done (`Resumed.hydrated`).
   */
  stale: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Present only on a patch written after the shell: the shell drew the
   * entry open. A client that reads it before hydration is done holds the
   * value until then, so each node it claims shows what the server drew. A
   * readiness boundary may draw it ahead: its marks let it replace the
   * server's branch (`Resumed.hydrated`).
   */
  late: Schema.optionalKey(Schema.Literal(true)),
});
export type Patch = Schema.Schema.Type<typeof Patch>;

/**
 * A route actor's committed snapshot, as the document carries it (#37): the
 * reference the route opened on the server, at the instant the drawing
 * shows. `id` is the route's key for that actor address; `revision` and
 * `snapshot` are the projection the wire carries, the snapshot still
 * encoded, so the client decodes it through its own contract. The client's
 * route opens its reference from it, so the first
 * frame holds the actor and nothing reads its snapshot again. Written with
 * the drawing, never later: a route actor is settled before its view draws.
 */
export const ActorSeed = Schema.TaggedStruct("ActorSeed", {
  id: Schema.String,
  revision: Schema.Finite,
  snapshot: Schema.String,
});
export type ActorSeed = Schema.Schema.Type<typeof ActorSeed>;

/** The close tag. Exactly one, last, and written on every exit path. */
export const Closed = Schema.TaggedStruct("Closed", {
  /** Every id this document settled. */
  patched: Schema.Array(Schema.String),
});
export type Closed = Schema.Schema.Type<typeof Closed>;

export const StreamRecord = Schema.Union([Placeholder, Patch, ActorSeed, Closed]);
export type StreamRecord = Schema.Schema.Type<typeof StreamRecord>;

/** One record as the JSON a document carries. */
export const RecordJson = Schema.fromJsonString(StreamRecord);

/** The `AwaitAll` seed as the JSON its script carries. */
export const SeedJson = Schema.fromJsonString(Schema.Array(Patch));

/**
 * The script a `SSR` or `AwaitAll` document writes beside the query seed:
 * the snapshot of every route actor the drawing holds. A streamed document
 * writes them as records in its first chunk instead.
 */
export const actorSeedId = "frame-actor-seed";

/** The route actors' snapshots as the JSON their script carries. */
export const ActorSeedJson = Schema.fromJsonString(Schema.Array(ActorSeed));

const placeholderOf = (key: QueryKey): Placeholder => ({
  _tag: "Placeholder",
  id: recordId(key),
  kind: "query",
});

type Encoded = QueryState<string, QueryFailureType>;

/** The patch a settled entry writes. `Loading` writes none. */
const patchOf = (key: QueryKey, state: Encoded): Option.Option<Patch> =>
  Match.value(state).pipe(
    Match.withReturnType<Option.Option<Patch>>(),
    Match.tagsExhaustive({
      Loading: () => Option.none(),
      Ready: (ready) => {
        const patch: Patch = {
          _tag: "Patch",
          id: recordId(key),
          outcome: { _tag: "Value", value: ready.value },
        };
        if (ready.stale) {
          return Option.some({ ...patch, stale: true });
        }
        return Option.some(patch);
      },
      Failed: (failed) =>
        Option.some({
          _tag: "Patch",
          id: recordId(key),
          outcome: { _tag: "Error", error: failed.error },
        }),
    }),
  );

const stateOf = (patch: Patch): Encoded =>
  Match.value(patch.outcome).pipe(
    Match.withReturnType<Encoded>(),
    Match.tagsExhaustive({
      // A baked value, or one the server showed stale, is one this client
      // has not confirmed.
      Value: (value) =>
        Ready(
          value.value,
          Option.isSome(Option.fromNullishOr(patch.builtAt)) ||
            Option.isSome(Option.fromNullishOr(patch.stale)),
        ),
      Error: (error) => Failed(error.error),
    }),
  );

const accessOf: Effect.Effect<Option.Option<DocumentAccess>, never, QueryCache> = Effect.gen(
  function* () {
    return documentOf(yield* QueryCache);
  },
);

const noEntries: ReadonlyArray<DocumentEntry> = [];
const noActors: ReadonlyArray<ActorSeed> = [];

const entriesOf: Effect.Effect<ReadonlyArray<DocumentEntry>, never, QueryCache> = Effect.flatMap(
  accessOf,
  (access) =>
    Option.match(access, {
      onNone: () => Effect.succeed(noEntries),
      onSome: (found) => found.entries,
    }),
);

const settledEntry = (entry: DocumentEntry): Effect.Effect<Option.Option<Patch>> =>
  Effect.map(entry.state.get, (state) => patchOf(entry.key, state));

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

/** What a streamed render writes after its shell. */
export interface ShellRecords {
  /** A placeholder for every entry the shell declared. */
  readonly placeholders: ReadonlyArray<Placeholder>;
  /** The snapshot of every route actor the shell holds. */
  readonly actors: ReadonlyArray<ActorSeed>;
  /** The patches already due: entries that settled while the shell rendered. */
  readonly settled: ReadonlyArray<Patch>;
  /** The other patches in settle order, then `Closed`. `Closed` is always last. */
  readonly later: Stream.Stream<Patch | Closed>;
}

export interface ShellOptions {
  /**
   * Write `Closed` when this completes, even with entries still open. A time
   * limit is `Effect.sleep`. It is required: a document that may stay open
   * for ever is a choice the author writes down, as `Effect.never`.
   */
  readonly closeWhen: Effect.Effect<void>;
}

/**
 * Read the cache after the shell rendered: the entries it declared are the
 * placeholders, and each one's first settle is its patch. The stream owns
 * no entry: the render that declared them must stay open until it ends.
 * An entry the render releases before it settles writes no patch: the
 * client reads it again. `Closed` is written after the last patch, when
 * `closeWhen` completes, or when the patch stream fails; the client needs
 * no other signal.
 */
export const shell: (options: ShellOptions) => Effect.Effect<ShellRecords, never, QueryCache> =
  Effect.fn("Streaming.shell")(function* (options: ShellOptions) {
    const entries = yield* entriesOf;
    const actors = yield* actorSeeds;
    const now = yield* Effect.forEach(entries, (entry) =>
      Effect.map(settledEntry(entry), (patch) => ({ entry, patch })),
    );
    const settled = now.flatMap((one) => Option.toArray(one.patch));
    const open = now.filter((one) => Option.isNone(one.patch)).map((one) => one.entry);
    const patched = settled.map((patch) => patch.id);
    // A released entry's state never changes again, so its watch ends there.
    const firstSettle = (entry: DocumentEntry): Stream.Stream<Patch> =>
      entry.state.changes.pipe(
        Stream.filterMap(Filter.fromPredicateOption((state: Encoded) => patchOf(entry.key, state))),
        Stream.take(1),
        Stream.interruptWhen(entry.released),
      );
    // Every open entry is watched at once: a patch is written the moment its
    // entry settles, so no entry may wait behind another. The set is the
    // shell's, fixed before the stream starts.
    const patches: Stream.Stream<Patch> = Stream.mergeAll(open.map(firstSettle), {
      concurrency: Math.max(open.length, 1),
    }).pipe(
      // Each of these settles after the shell drew its entry open.
      Stream.map((patch): Patch => ({ ...patch, late: true })),
      Stream.tap((patch) => Effect.sync(() => void patched.push(patch.id))),
      Stream.interruptWhen(options.closeWhen),
      Stream.catchCause(() => Stream.empty),
    );
    const closed: Stream.Stream<Closed> = Stream.suspend(() =>
      Stream.succeed({ _tag: "Closed", patched: [...patched] }),
    );
    return {
      placeholders: entries.map((entry) => placeholderOf(entry.key)),
      actors,
      settled,
      later: Stream.concat<Patch | Closed, never, never, Patch | Closed, never, never>(
        patches,
        closed,
      ),
    } satisfies ShellRecords;
  });

/** The id of every entry declared now. */
export const declared: Effect.Effect<ReadonlyArray<RecordId>, never, QueryCache> = Effect.map(
  entriesOf,
  (entries) => entries.map((entry) => recordId(entry.key)),
);

/**
 * Wait until every entry declared now has settled, as a Ready value or a
 * failure, or the render has released it. A render that begins after this
 * reads each one it still declares settled.
 */
export const awaitDeclared: Effect.Effect<void, never, QueryCache> = Effect.flatMap(
  entriesOf,
  (entries) =>
    Effect.forEach(
      entries,
      (entry) =>
        entry.state.changes.pipe(
          Stream.filter((state) => state._tag !== "Loading"),
          Stream.take(1),
          // An entry the render released stops the wait too: nothing settles it now.
          Stream.interruptWhen(entry.released),
          Stream.runDrain,
        ),
      { concurrency: Math.max(entries.length, 1), discard: true },
    ),
);

/**
 * The snapshot of every route actor held now, in the order the route
 * opened them. A cache with no document holds none.
 */
export const actorSeeds: Effect.Effect<
  ReadonlyArray<ActorSeed>,
  never,
  QueryCache
> = Effect.flatMap(accessOf, (access) =>
  Option.match(access, {
    onNone: () => Effect.succeed(noActors),
    onSome: (found) => found.actors,
  }),
);

/** The patch of every settled entry declared now: the `AwaitAll` seed. */
export const settledPatches: Effect.Effect<
  ReadonlyArray<Patch>,
  never,
  QueryCache
> = Effect.flatMap(entriesOf, (entries) =>
  Effect.map(Effect.forEach(entries, settledEntry), (patches) => patches.flatMap(Option.toArray)),
);

// ---------------------------------------------------------------------------
// The client half
// ---------------------------------------------------------------------------

/** The records a document holds now, and the ones appended after. */
export interface DocumentRecords {
  readonly present: ReadonlyArray<StreamRecord>;
  /** Completes on `Closed`, or when the document ended without one. */
  readonly later: Stream.Stream<StreamRecord>;
}

export interface Resumed {
  /**
   * Completes once the record channel is over: `Closed` arrived, or the
   * document ended without it. Every entry is settled by then, or failed
   * `StreamEnded`. A consumer that must see one agreed tree, such as a
   * server-driven op wire, starts after this and after hydration.
   */
  readonly closed: Effect.Effect<void>;
  /**
   * Run it once hydration is done. A seed no view took is dropped then, so
   * a key a view declares later reads over the query path, never a value
   * the document held since the page loaded. The reads that seeds call for
   * start then too (a stale value, a failure that is not final,
   * `StreamEnded`): until hydration is done, an entry shows what the server
   * drew. A client that never runs it never reads those keys again.
   */
  readonly hydrated: Effect.Effect<void>;
}

/**
 * Seed the cache from the document, then follow late patches. Run it once,
 * before `mount`: the records already present land synchronously, so a view
 * that declares a patched key sees its value on its first read and never
 * starts a fetch. The rest are followed in the caller's scope. A patch the
 * server wrote after its shell (`Patch.late`) is held until hydration is
 * done, so the first drawing shows what the server drew; a readiness
 * boundary may draw it ahead (`read-ahead.ts`).
 *
 * A placeholder that nothing settles fails `StreamEnded` when the channel
 * ends, whether `Closed` said so or the response was cut. That entry reads
 * again over the ordinary query path once hydration is done
 * (`Resumed.hydrated`), and so does an entry whose patch is a failure other
 * than the query's own `QueryFailed`. A route actor's snapshot is held for
 * the routes that open the actor while the page hydrates, and dropped once
 * hydration is done: a later route reads the actor. A cache
 * not built by `QueryCache.layer` has nowhere to put a seed: its views read
 * normally.
 */
export const resume: (
  records: DocumentRecords,
) => Effect.Effect<Resumed, never, QueryCache | Scope.Scope> = Effect.fn("Streaming.resume")(
  function* (records: DocumentRecords) {
    const closed = yield* Deferred.make<void>();
    const access = yield* accessOf;
    if (Option.isNone(access)) {
      yield* Deferred.succeed(closed, void 0);
      return { closed: Deferred.await(closed), hydrated: Effect.void } satisfies Resumed;
    }
    const document = access.value;
    const end = Effect.andThen(document.end, Deferred.succeed(closed, void 0));
    const apply = (record: StreamRecord): Effect.Effect<void> =>
      Match.value(record).pipe(
        Match.withReturnType<Effect.Effect<void>>(),
        Match.tagsExhaustive({
          Placeholder: (placeholder) => document.placeholder(placeholder.id),
          Patch: (patch) =>
            document.settle(
              patch.id,
              stateOf(patch),
              Option.isSome(Option.fromNullishOr(patch.late)),
            ),
          ActorSeed: (seed) =>
            document.seedActor(seed.id, { revision: seed.revision, snapshot: seed.snapshot }),
          Closed: () => end,
        }),
      );
    yield* Effect.forEach(records.present, apply, { discard: true });
    yield* Effect.forkScoped(Stream.runForEach(records.later, apply).pipe(Effect.ensuring(end)));
    return { closed: Deferred.await(closed), hydrated: document.expire } satisfies Resumed;
  },
);
