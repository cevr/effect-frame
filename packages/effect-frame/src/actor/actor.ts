import { Deferred, Effect, Function, Option, Stream } from "effect";
import type { Behavior, SetValue } from "./behavior.js";
import { Value } from "./behavior.js";
import { openLocal } from "./local-engine.js";
import { select } from "./source.js";
import { toApplied } from "./command-handle.js";
import type { Committed } from "./engine-types.js";
import type { LocalEngine } from "./local-engine.js";
import type { Source } from "./source.js";
import type {
  ActorRef,
  Applied,
  CommandHandle,
  CommandSettled,
  CommandState,
  Refused,
} from "./vocabulary.js";
import { ActorStopped, committedRevision } from "./vocabulary.js";

type LocalState<State, Refusal> = CommandState<State, "local", Refusal>;
type LocalSettled<State, Refusal> = CommandSettled<State, "local", Refusal>;

const appliedState = <State>(
  admitted: number,
  committed: Committed<State>,
): LocalSettled<State, never> => ({
  _tag: "Applied",
  admitted,
  revision: committedRevision(committed.revision),
  state: committed.state,
});

const stoppedState: LocalSettled<never, never> = { _tag: "Rejected", reason: ActorStopped.make() };

/** An actor that stopped before admission: the handle is already terminal. */
const stoppedHandle = <State, Refusal>(): CommandHandle<State, "local", Refusal> => ({
  state: { get: Effect.succeed(stoppedState), changes: Stream.succeed(stoppedState) },
  settled: Effect.succeed(stoppedState),
});

/**
 * One admitted local message as a handle. A local command has no ID and is
 * never uncertain: its mailbox is in this process, so it either applies or
 * the actor stops before its turn.
 */
const localHandle = <State, Message, Refusal>(
  engine: LocalEngine<State, Message, Refusal>,
  admitted: number,
  reply: Deferred.Deferred<Committed<State>, Refusal>,
): CommandHandle<State, "local", Refusal> => {
  const final: Effect.Effect<LocalSettled<State, Refusal>> = Effect.flatMap(
    Deferred.poll(reply),
    (done) =>
      Option.match(done, {
        onNone: () => Effect.succeed(stoppedState),
        // A refused message's reply fails with the refusal: Rejected, with
        // no revision.
        onSome: (value) =>
          Effect.match(value, {
            onFailure: (reason): LocalSettled<State, Refusal> => ({ _tag: "Rejected", reason }),
            onSuccess: (committed) => appliedState(admitted, committed),
          }),
      }),
  );
  // Read the stop flag first: once it is true, an empty reply stays empty.
  const read: Effect.Effect<LocalState<State, Refusal>> = Effect.gen(function* () {
    const stopped = yield* engine.isClosed;
    const done = yield* Deferred.isDone(reply);
    if (stopped || done) {
      return yield* final;
    }
    return { _tag: "Admitted", admitted };
  });
  const settled = Effect.matchEffect(engine.awaitReply(reply), {
    onSuccess: (committed) => Effect.succeed(appliedState(admitted, committed)),
    onFailure: () => final,
  });
  const state: Source<LocalState<State, Refusal>> = {
    get: read,
    // The current value, then the terminal value once, unless the current
    // value already is terminal.
    changes: Stream.unwrap(
      Effect.map(read, (current) => {
        if (current._tag === "Admitted") {
          return Stream.concat(Stream.succeed(current), Stream.fromEffect(settled));
        }
        return Stream.succeed(current);
      }),
    ),
  };
  return { state, settled };
};

/**
 * A local reference adds `derive`: compute the message from the current state
 * inside the actor's turn, so read and send cannot interleave with another
 * message.
 */
export interface LocalActorRef<State, Message, Refusal = never> extends ActorRef<
  State,
  Message,
  "local",
  Refusal
> {
  readonly derive: (
    derive: (state: State) => Message,
  ) => Effect.Effect<Applied<State>, ActorStopped | Refusal>;
}

/**
 * Spawn a local actor in the current scope. Messages run in admission order.
 * Closing the scope stops the actor; every waiting `call` fails with
 * `ActorStopped`.
 */
export const spawn = Effect.fn("Actor.spawn")(function* <
  State,
  Message,
  R,
  Refusal extends Refused = never,
>(behavior: Behavior<State, Message, R, Refusal>) {
  const engine = yield* openLocal(behavior);
  const applied = select(engine.committed, toApplied);
  const send = Effect.fn("Actor.send")(function* (message: Message) {
    return yield* engine
      .admit(() => message)
      .pipe(
        Effect.match({
          onFailure: () => stoppedHandle<State, Refusal>(),
          onSuccess: ({ admitted, reply }) => localHandle(engine, admitted, reply),
        }),
      );
  });
  const call = Effect.fn("Actor.call")(function* (message: Message) {
    const { reply } = yield* engine.admit(() => message);
    return yield* Effect.map(engine.awaitReply(reply), toApplied);
  });
  const derive = Effect.fn("Actor.derive")(function* (compute: (state: State) => Message) {
    const { reply } = yield* engine.admit(compute);
    return yield* Effect.map(engine.awaitReply(reply), toApplied);
  });
  const reference: LocalActorRef<State, Message, Refusal> = {
    kind: "local",
    applied,
    // Nothing here predicts: the displayed value is the committed one.
    displayed: applied,
    state: select(applied, (committed) => committed.state),
    send,
    call,
    derive,
  };
  return reference;
});

/**
 * Update simple state from its current value inside one turn. Only a local
 * reference to a `Behavior.value` actor has this. The message that reaches the
 * behavior is still a plain `Set`.
 */
export const modify: {
  <A>(
    update: (value: A) => A,
  ): <Refusal>(
    ref: LocalActorRef<A, SetValue<A>, Refusal>,
  ) => Effect.Effect<Applied<A>, ActorStopped | Refusal>;
  <A, Refusal>(
    ref: LocalActorRef<A, SetValue<A>, Refusal>,
    update: (value: A) => A,
  ): Effect.Effect<Applied<A>, ActorStopped | Refusal>;
} = Function.dual(
  2,
  <A, Refusal>(
    ref: LocalActorRef<A, SetValue<A>, Refusal>,
    update: (value: A) => A,
  ): Effect.Effect<Applied<A>, ActorStopped | Refusal> =>
    ref.derive((value) => Value.Set(update(value))),
);
