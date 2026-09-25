// #region contract
import { Behavior, contract, query } from "effect-frame/actor/client";
import { Match, Schema } from "effect";

// A message is a tagged struct. A form posts strings, so a number field
// decodes from a string: `FiniteFromString`, not `Finite`.
export const Increment = Schema.TaggedStruct("Increment", { by: Schema.FiniteFromString });
export const Reset = Schema.TaggedStruct("Reset", {});
export const CounterMessage = Schema.Union([Increment, Reset]);
export type CounterMessage = Schema.Schema.Type<typeof CounterMessage>;

// The contract is the public face of an actor: its key, its snapshot, its
// messages, and the policy that judges every read and send. Browser safe.
export const Counter = contract("Counter", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ name: Schema.String }),
  snapshot: Schema.Finite,
  message: CounterMessage,
});

// The behavior is pure and browser safe too: the server runs it, and a
// page that holds it predicts a send before the server commits it.
export const counterBehavior = Behavior.reducer<number, CounterMessage>({
  initial: 0,
  reduce: (count, message) =>
    Match.valueTags(message, {
      Increment: (increment) => count + increment.by,
      Reset: () => 0,
    }),
});

// A query is a named server read. `depends` names the contracts whose
// commits make it stale; `version` is its wire version, as a contract's is.
export const CounterNames = query("CounterNames", {
  version: 1,
  args: Schema.Struct({}),
  result: Schema.Array(Schema.String),
  policy: "public",
  depends: [Counter],
});
// #endregion contract
