import type { Duration, Option } from "effect";
import { Deferred, Effect, Equal, Queue, Ref, Schema, Stream, SubscriptionRef } from "effect";
import type { Behavior, SetValue } from "./behavior.js";
import { Value } from "./behavior.js";
import type { Source } from "./source.js";
import { fromSubscriptionRef } from "./source.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = Schema.Schema.Type<typeof CommandId>;

/** The actor stopped before it processed the message. */
export class ActorStopped extends Schema.TaggedError<ActorStopped>()("ActorStopped", {}) {}

/** The same command ID arrived with a different payload. */
export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  commandId: CommandId,
}) {}

/**
 * The wait ended before a receipt arrived. The command may still commit.
 * Retry with the same command ID.
 */
export class Uncertain extends Schema.TaggedError<Uncertain>()("Uncertain", {
  commandId: CommandId,
}) {}

/** The result of one processed message. `revision` is the actor's monotonic clock. */
export interface Applied<State> {
  readonly revision: number;
  readonly state: State;
}

/** Acceptance of a local message. `admitted` is the mailbox admission order. */
export interface Admitted {
  readonly admitted: number;
}

/**
 * Acceptance of a durable command. `committed` is present when the mailbox
 * already holds a receipt for this command ID.
 */
export interface DurableReceipt {
  readonly commandId: CommandId;
  readonly admitted: number;
  readonly committed: Option.Option<number>;
}

export type ActorKind = "local" | "durable";

export interface SendOptions {
  readonly local: void;
  readonly durable: { readonly commandId: CommandId };
}

export interface Receipt {
  readonly local: Admitted;
  readonly durable: DurableReceipt;
}

export interface SendError {
  readonly local: ActorStopped;
  readonly durable: ActorStopped | CommandConflict;
}

export interface CallOptions {
  readonly local: void;
  readonly durable: { readonly commandId: CommandId; readonly timeout: Duration.Input };
}

export interface CallError {
  readonly local: ActorStopped;
  readonly durable: ActorStopped | CommandConflict | Uncertain;
}

/**
 * One reference type for local and durable actors. `Kind` selects the
 * receipt, option, and error types, so placement is visible in the type and
 * a durable reference cannot be called without a command ID and a timeout.
 */
export interface ActorRef<State, Message, Kind extends ActorKind> {
  readonly kind: Kind;
  readonly state: Source<State>;
  readonly send: (
    message: Message,
    options: SendOptions[Kind],
  ) => Effect.Effect<Receipt[Kind], SendError[Kind]>;
  readonly call: (
    message: Message,
    options: CallOptions[Kind],
  ) => Effect.Effect<Applied<State>, CallError[Kind]>;
}

// ---------------------------------------------------------------------------
// Local actor
// ---------------------------------------------------------------------------

interface MessageEnvelope<State, Message> {
  readonly _tag: "Message";
  /** Computes the message inside the turn, from the state the turn sees. */
  readonly derive: (state: State) => Message;
  readonly reply: Deferred.Deferred<Applied<State>>;
}

interface AutonomousEnvelope<State> {
  readonly _tag: "Autonomous";
  readonly state: State;
}

type Envelope<State, Message> = MessageEnvelope<State, Message> | AutonomousEnvelope<State>;

/**
 * A local reference adds `derive`: compute the message from the current state
 * inside the actor's turn, so read and send cannot interleave with another
 * message. The message still goes through the behavior. A durable reference
 * has no `derive`, because a function cannot cross the durable boundary.
 */
export interface LocalActorRef<State, Message> extends ActorRef<State, Message, "local"> {
  readonly derive: (
    derive: (state: State) => Message,
  ) => Effect.Effect<Applied<State>, ActorStopped>;
}

/**
 * Spawn a local actor in the current scope. Messages run in admission order.
 * Closing the scope stops the actor; every waiting `call` fails with
 * `ActorStopped`.
 */
export const spawn = Effect.fn("Actor.spawn")(function* <State, Message, R>(
  behavior: Behavior<State, Message, R>,
) {
  const turn = yield* behavior.open(behavior.initial);
  const state = yield* SubscriptionRef.make(behavior.initial);
  const revision = yield* Ref.make(0);
  const admission = yield* Ref.make(0);
  const stopped = yield* Ref.make(false);
  const closed = yield* Deferred.make<never, ActorStopped>();
  const mailbox = yield* Queue.unbounded<Envelope<State, Message>>();

  const commitState = (next: State) =>
    Effect.andThen(
      Ref.updateAndGet(revision, (n) => n + 1),
      (applied) => Effect.as(SubscriptionRef.set(state, next), applied),
    );

  const step = Effect.gen(function* () {
    const envelope = yield* Queue.take(mailbox);
    const current = yield* SubscriptionRef.get(state);
    if (envelope._tag === "Autonomous") {
      if (!Equal.equals(envelope.state, current)) {
        yield* commitState(envelope.state);
      }
      return;
    }
    const next = yield* turn.apply(current, envelope.derive(current));
    const applied = yield* commitState(next);
    yield* Deferred.succeed(envelope.reply, { revision: applied, state: next });
  });

  yield* Effect.addFinalizer(() =>
    Ref.set(stopped, true).pipe(Effect.andThen(Deferred.fail(closed, ActorStopped.make()))),
  );
  yield* Effect.forkScoped(Effect.forever(step));
  yield* Effect.forkScoped(
    Stream.runForEach(turn.changes, (changed) =>
      Queue.offer(mailbox, { _tag: "Autonomous", state: changed }),
    ),
  );

  const admit = Effect.fn("Actor.admit")(function* (derive: (state: State) => Message) {
    const isStopped = yield* Ref.get(stopped);
    if (isStopped) {
      return yield* ActorStopped.make();
    }
    const reply = yield* Deferred.make<Applied<State>>();
    const admitted = yield* Ref.updateAndGet(admission, (n) => n + 1);
    yield* Queue.offer(mailbox, { _tag: "Message", derive, reply });
    return { admitted, reply };
  });

  const awaitReply = (reply: Deferred.Deferred<Applied<State>>) =>
    Effect.raceFirst(Deferred.await(reply), Deferred.await(closed));

  const send = Effect.fn("Actor.send")(function* (message: Message) {
    const { admitted } = yield* admit(() => message);
    return { admitted } satisfies Admitted;
  });

  const call = Effect.fn("Actor.call")(function* (message: Message) {
    const { reply } = yield* admit(() => message);
    return yield* awaitReply(reply);
  });

  const derive = Effect.fn("Actor.derive")(function* (compute: (state: State) => Message) {
    const { reply } = yield* admit(compute);
    return yield* awaitReply(reply);
  });

  const ref: LocalActorRef<State, Message> = {
    kind: "local",
    state: fromSubscriptionRef(state),
    send,
    call,
    derive,
  };
  return ref;
});

/**
 * Update simple state from its current value inside one turn. Only a local
 * reference to a `Behavior.value` actor has this. The message that reaches
 * the behavior is still a plain `Set`.
 */
export const modify = <A>(
  ref: LocalActorRef<A, SetValue<A>>,
  update: (value: A) => A,
): Effect.Effect<Applied<A>, ActorStopped> => ref.derive((value) => Value.Set(update(value)));
