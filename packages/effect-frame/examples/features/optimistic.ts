import { Actor } from "effect-frame/actor/client";
import { Effect, Option } from "effect";
import { Counter, Increment, counterBehavior } from "../counter/contract.js";

// #region optimistic
// A reference given the actor's behavior predicts each fresh send before
// the server commits it. `Behavior.value` and `Behavior.reducer` predict;
// `Behavior.machine` does not.
export const program = Effect.gen(function* () {
  const counter = yield* Actor.remote(
    Counter,
    { name: "home" },
    { resume: Option.none(), behavior: counterBehavior },
  );
  const handle = yield* counter.send(Increment.make({ by: 1 }));
  // { revision: { _tag: "Provisional", base, depth: 1 }, state }
  const shown = yield* counter.displayed.get;
  // The committed revision only: use it for resume data.
  const committed = yield* counter.applied.get;
  return { handle, shown, committed };
});
// #endregion optimistic
