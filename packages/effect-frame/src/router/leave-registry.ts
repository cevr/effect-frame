import type { Effect } from "effect";
import type { RouterService } from "./router.js";

/**
 * PRIVATE. The part of leave checks that the router reads: a mounted
 * route's `Entered.questions` is an `Asker`.
 * It holds no `Router` value, so the router can import it without a cycle.
 * See `leave.ts` for the registration a view makes, and
 * `docs/design/route-leave.md`.
 */

export interface Stay {
  readonly _tag: "Stay";
}

export interface Leave {
  readonly _tag: "Leave";
}

/** What a leave check answers. A union, so no check can answer both. */
export type LeaveVerdict = Stay | Leave;

export const Stay: Stay = { _tag: "Stay" };
export const Leave: Leave = { _tag: "Leave" };

/** How the document would move. A leave check never sees the initial mount. */
export type LeaveKind = "push" | "replace" | "pop";

/** One candidate the router asks a mounted route about. */
export interface Candidate {
  readonly destination: URL;
  readonly kind: LeaveKind;
  /** The candidate resolves to the route that is mounted now. */
  readonly stays: boolean;
}

/**
 * One registered check, already bound to its input for this candidate. The
 * router gives it the read-only Router a check may see: the queue fiber
 * runs it, so a move from inside it could never be served.
 */
export type Question = (router: RouterService) => Effect.Effect<LeaveVerdict>;

/**
 * The checks one mounted route would ask for a candidate, deepest first.
 * Collecting them asks nothing: the router decides whether it may ask.
 */
export type Asker = (candidate: Candidate) => Effect.Effect<ReadonlyArray<Question>>;
