import type { Entered } from "./route.js";
import { Option } from "effect";
import type { Effect } from "effect";

/** Values projected from the built-in route's decoded memory. */
interface EnteredInspection {
  readonly params: unknown;
  readonly search: unknown;
}

const projections = new WeakMap<object, Effect.Effect<EnteredInspection>>();

/** Read a framework-owned projection. Custom routes have no projection. */
export const read = <R>(entered: Entered<R>): Option.Option<Effect.Effect<EnteredInspection>> =>
  Option.fromNullishOr(projections.get(entered));

/** Register a projection made from a built-in route memory ref. */
export const register = <R>(
  entered: Entered<R>,
  projection: Effect.Effect<EnteredInspection>,
): void => {
  projections.set(entered, projection);
};
