import type { Schema, Scope } from "effect";
import { Effect, Option, Stream } from "effect";
import { Machine } from "effect-machine";
import type { Refused } from "./vocabulary.js";

/**
 * One open behavior instance. `apply` runs one message against the current
 * state and returns the next state. The actor owns ordering; `apply` never
 * sees two messages at once.
 */
export interface Turn<State, Message> {
  readonly apply: (state: State, message: Message) => Effect.Effect<State>;
  /**
   * State changes the behavior makes on its own, with no message: a machine
   * task completing, an immediate transition. The actor commits each one as
   * a revision. A value or reducer never changes on its own.
   */
  readonly changes: Stream.Stream<State>;
}

/**
 * The rules that process an actor's messages and change its private state.
 * The actor owns identity, mailbox, and lifetime. The behavior defines what
 * messages mean. `open` receives the state the actor starts from: the initial
 * state on first spawn, or the committed state on recovery.
 *
 * `Refusal` is `Refused` when the behavior has a `refuse` rule, and `never`
 * when it has none: a reference to it can be `Rejected(Refused)` only then.
 */
export interface Behavior<State, Message, R = never, Refusal extends Refused = never> {
  readonly initial: State;
  readonly open: (state: State) => Effect.Effect<Turn<State, Message>, never, R | Scope.Scope>;
  /**
   * A pure, synchronous copy of `apply`, for a client's provisional state.
   * `value` and `reducer` have it. `machine` does not: a machine's next state
   * can depend on a task result. When it is absent, a client never applies
   * a message before the server commits it. There is no flag beside it.
   */
  readonly predict?: (state: State, message: Message) => State;
  /**
   * The messages this behavior refuses (#37, #25 §1). It reads the message
   * alone, never the state, so the same bytes are refused every time and a
   * refusal is conclusive for its command ID. A durable or hosted actor asks
   * it before it admits a new command; a local actor asks it before the
   * message's turn; a predicting reference asks it before it predicts. A
   * refused message is never applied and commits no revision: its handle is
   * `Rejected(Refused)`. Absent: every message is accepted.
   */
  readonly refuse?: (message: Message) => Option.Option<Refusal>;
}

/**
 * The refusal of one message, if the behavior has a rule and it refuses.
 * A behavior with no rule refuses nothing.
 */
export const refusalOf = <State, Message, R, Refusal extends Refused>(
  behavior: Behavior<State, Message, R, Refusal>,
  message: Message,
): Option.Option<Refusal> =>
  Option.flatMap(Option.fromNullishOr(behavior.refuse), (refuse) => refuse(message));

export interface SetValue<A> {
  readonly _tag: "Set";
  readonly value: A;
}

export const Value = {
  Set: <A>(value: A): SetValue<A> => ({ _tag: "Set", value }),
};

/**
 * Simple state. The only message is a serializable replacement. A `modify`
 * helper lives on the local reference, not here, because an updater function
 * cannot cross the durable boundary.
 */
export interface ValueOptions<A, Refusal extends Refused> {
  /** A value this actor refuses to hold. See `Behavior.refuse`. */
  readonly refuse?: (value: A) => Option.Option<Refusal>;
}

export const value = <A, Refusal extends Refused = never>(
  initial: A,
  options: ValueOptions<A, Refusal> = {},
): Behavior<A, SetValue<A>, never, Refusal> => ({
  initial,
  predict: (_state, message) => message.value,
  ...Option.match(Option.fromNullishOr(options.refuse), {
    onNone: () => ({}),
    onSome: (refuse) => ({ refuse: (message: SetValue<A>) => refuse(message.value) }),
  }),
  open: () =>
    Effect.succeed({
      apply: (_state, message) => Effect.succeed(message.value),
      changes: Stream.empty,
    }),
});

export interface ReducerOptions<State, Message, Refusal extends Refused = never> {
  readonly initial: State;
  /** Total: every message the behavior does not refuse reduces. */
  readonly reduce: (state: State, message: Message) => State;
  /** The messages this behavior refuses. See `Behavior.refuse`. */
  readonly refuse?: (message: Message) => Option.Option<Refusal>;
}

/** Event-to-state transitions with no state chart. */
export const reducer = <State, Message, Refusal extends Refused = never>(
  options: ReducerOptions<State, Message, Refusal>,
): Behavior<State, Message, never, Refusal> => ({
  initial: options.initial,
  predict: options.reduce,
  ...Option.match(Option.fromNullishOr(options.refuse), {
    onNone: () => ({}),
    onSome: (refuse) => ({ refuse }),
  }),
  open: () =>
    Effect.succeed({
      apply: (state, message) => Effect.sync(() => options.reduce(state, message)),
      changes: Stream.empty,
    }),
});

interface Tagged {
  readonly _tag: string;
}

/**
 * An Effect Machine as behavior. The machine actor is an implementation
 * detail: it is spawned inside `open`, hydrated from the given state, and
 * stopped with the owning scope. Its `ActorRef` is not exposed.
 *
 * A machine never predicts. A transition can run a task with server
 * requirements and real effects, so its next state is not a pure function a
 * client could run.
 */
export const machine = <
  State extends Tagged,
  Event extends Tagged,
  R,
  StateDefinition extends Record<string, Schema.Struct.Fields>,
  EventDefinition extends Record<string, Schema.Struct.Fields>,
  Output,
>(
  definition: Machine.Machine<State, Event, R, StateDefinition, EventDefinition, void, Output>,
): Behavior<State, Event, R> => ({
  initial: definition.initial,
  open: Effect.fn("Behavior.machine.open")(function* (state: State) {
    const actor = yield* Machine.spawn(definition, { hydrate: state });
    yield* actor.start;
    yield* Effect.addFinalizer(() => actor.stop);
    return {
      apply: (_state, event) => Effect.map(actor.call(event), (result) => result.newState),
      changes: actor.changes,
    };
  }),
});
