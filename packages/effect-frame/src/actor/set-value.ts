/**
 * The one message of a `Behavior.value` actor: replace the value. It is a
 * flat export beside `Behavior`, which holds only what builds a behavior.
 */
export interface SetValue<A> {
  readonly _tag: "Set";
  readonly value: A;
}

/** Build the message that replaces a value actor's state: `Value.Set(next)`. */
export const Value = {
  Set: <A>(value: A): SetValue<A> => ({ _tag: "Set", value }),
};
