import { Option } from "effect";
import type { Behavior } from "./behavior.js";
import type { Refused } from "./vocabulary.js";

// The engines' reads of a behavior's optional rules. Not exported from an
// entry: `Behavior.*` holds only what an author writes.

/**
 * When a state next needs the actor, if the behavior names one.
 */
export const wakeOf = <State, Message, R, Refusal extends Refused>(
  behavior: Behavior<State, Message, R, Refusal>,
  state: State,
): Option.Option<number> =>
  Option.flatMap(Option.fromNullishOr(behavior.wakeAt), (wakeAt) => wakeAt(state));

/**
 * The refusal of one message, if the behavior has a rule and it refuses.
 * A behavior with no rule refuses nothing.
 */
export const refusalOf = <State, Message, R, Refusal extends Refused>(
  behavior: Behavior<State, Message, R, Refusal>,
  message: Message,
): Option.Option<Refusal> =>
  Option.flatMap(Option.fromNullishOr(behavior.refuse), (refuse) => refuse(message));
