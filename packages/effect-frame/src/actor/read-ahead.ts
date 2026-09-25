import { Effect, Option } from "effect";
import type { QueryState } from "./query.js";
import { mapEffect } from "./source.js";
import type { Source } from "./source.js";

/**
 * Streamed documents, client side: a patch the server wrote after its
 * shell (`Patch.late`) and that the client read before hydration is done.
 * The shell drew the entry open, so the cache holds the patch until
 * `Resumed.hydrated`: until then each node the client claims shows what the
 * server drew. A readiness boundary is the exception. Its marks let it
 * replace the server's branch, so it may draw the held value ahead: `ready`
 * and `orErrored` read their state through `readAhead`.
 *
 * Source-private. An entry's state source carries the held value as a
 * capability. A source derived from it (`select`, `zip`) does not, so a
 * boundary over it waits for hydration, as a claimed node does.
 */

const heldPatch: unique symbol = Symbol("effect-frame/actor/read-ahead/heldPatch");

interface Holding<A, E> extends Source<QueryState<A, E>> {
  readonly [heldPatch]: Effect.Effect<Option.Option<QueryState<A, E>>>;
}

/** Only `holding` attaches the capability, and with the source's own types. */
const isHolding = <A, E>(source: Source<QueryState<A, E>>): source is Holding<A, E> =>
  heldPatch in source;

/**
 * `source` with the value its entry holds back until hydration is done.
 * `peek` is `None` once nothing is held: the value landed, or none came.
 */
export const holding = <A, E>(
  source: Source<QueryState<A, E>>,
  peek: Effect.Effect<Option.Option<QueryState<A, E>>>,
): Source<QueryState<A, E>> => {
  const held: Holding<A, E> = {
    get: source.get,
    changes: source.changes,
    [heldPatch]: peek,
  };
  return held;
};

/** The held value of the entry behind `source`, if it carries one. */
export const heldOf = <A, E>(
  source: Source<QueryState<A, E>>,
): Effect.Effect<Option.Option<QueryState<A, E>>> => {
  if (isHolding(source)) {
    return source[heldPatch];
  }
  return Effect.succeed(Option.none());
};

/**
 * `source` as a readiness boundary reads it: while `ahead()` holds and the
 * entry still shows `Loading`, the value it holds back instead. The result
 * carries the capability too, so a second facade over it reads the same.
 */
export const readAhead = <A, E>(
  source: Source<QueryState<A, E>>,
  ahead: () => boolean,
): Source<QueryState<A, E>> => {
  if (!isHolding(source)) {
    return source;
  }
  const peek = source[heldPatch];
  const shown = (state: QueryState<A, E>): Effect.Effect<QueryState<A, E>> => {
    if (state._tag !== "Loading" || !ahead()) {
      return Effect.succeed(state);
    }
    return Effect.map(
      peek,
      Option.getOrElse(() => state),
    );
  };
  return holding(mapEffect(source, shown), peek);
};
