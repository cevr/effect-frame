import { Deferred, Effect, Equal, Option, Queue, Ref, Stream, SubscriptionRef } from "effect";
import * as Inspection from "../inspection.js";
import { refusalOf } from "./behavior-rules.js";
import type { Behavior } from "./behavior.js";
import type { Committed } from "./engine-types.js";
import { fromSubscriptionRef } from "./source.js";
import type { Source } from "./source.js";
import { ActorStopped } from "./vocabulary.js";
import type { Refused } from "./vocabulary.js";

interface MessageEnvelope<State, Message, Refusal> {
  readonly _tag: "Message";
  /** Computes the message inside the turn, from the state the turn sees. */
  readonly derive: (state: State) => Message;
  readonly reply: Deferred.Deferred<Committed<State>, Refusal>;
}

interface AutonomousEnvelope<State> {
  readonly _tag: "Autonomous";
  readonly state: State;
}

type Envelope<State, Message, Refusal> =
  | MessageEnvelope<State, Message, Refusal>
  | AutonomousEnvelope<State>;

export interface LocalAdmission<State, Refusal = never> {
  readonly admitted: number;
  /** Fails with the behavior's refusal: that message commits nothing. */
  readonly reply: Deferred.Deferred<Committed<State>, Refusal>;
}

export interface LocalEngine<State, Message, Refusal = never> {
  readonly committed: Source<Committed<State>>;
  /**
   * True once the engine has stopped. The worker is interrupted before this
   * turns true, so a reply that is still empty then will never be filled.
   */
  readonly isClosed: Effect.Effect<boolean>;
  readonly admit: (
    derive: (state: State) => Message,
  ) => Effect.Effect<LocalAdmission<State, Refusal>, ActorStopped>;
  readonly awaitReply: (
    reply: Deferred.Deferred<Committed<State>, Refusal>,
  ) => Effect.Effect<Committed<State>, ActorStopped | Refusal>;
}

/**
 * Opens the private in-process engine used by `Actor.spawn`.
 *
 * The engine owns one behavior turn, one mailbox, one commit source, and two
 * workers. The public actor module only supplies the stable facade and the
 * `modify` helper; no durable module is reachable from this browser-safe file.
 */
export const openLocal = Effect.fn("Actor.local.open")(function* <
  State,
  Message,
  R,
  Refusal extends Refused = never,
>(behavior: Behavior<State, Message, R, Refusal>) {
  const turn = yield* behavior.open(behavior.initial);
  const committed = yield* SubscriptionRef.make<Committed<State>>({
    revision: 0,
    state: behavior.initial,
  });
  const admission = yield* Ref.make(0);
  const stopped = yield* Ref.make(false);
  const closed = yield* Deferred.make<never, ActorStopped>();
  const mailbox = yield* Queue.unbounded<Envelope<State, Message, Refusal>>();

  const commitState = (next: State) =>
    SubscriptionRef.modify(committed, (current): readonly [Committed<State>, Committed<State>] => {
      const nextCommitted = { revision: current.revision + 1, state: next };
      return [nextCommitted, nextCommitted];
    });

  /** What an autonomous change commits: the behavior's own state when it names one. */
  const stateOf = (carried: State): Effect.Effect<State> =>
    Option.match(Option.fromNullishOr(turn.current), {
      onNone: () => Effect.succeed(carried),
      onSome: (current) => current,
    });

  const step = Effect.gen(function* () {
    const envelope = yield* Queue.take(mailbox);
    const current = yield* SubscriptionRef.get(committed);
    if (envelope._tag === "Autonomous") {
      const changed = yield* stateOf(envelope.state);
      if (!Equal.equals(changed, current.state)) {
        yield* commitState(changed);
      }
      return;
    }
    const message = envelope.derive(current.state);
    // A refused message is never applied: no turn, no revision (#37).
    const refusal = refusalOf(behavior, message);
    if (Option.isSome(refusal)) {
      yield* Deferred.fail(envelope.reply, refusal.value);
      return;
    }
    const next = yield* turn.apply(current.state, message);
    const result = yield* commitState(next);
    yield* Deferred.succeed(envelope.reply, result);
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

  const admit = Effect.fn("Actor.local.admit")(function* (derive: (state: State) => Message) {
    const isStopped = yield* Ref.get(stopped);
    if (isStopped) {
      return yield* ActorStopped.make();
    }
    const reply = yield* Deferred.make<Committed<State>, Refusal>();
    const admitted = yield* Ref.updateAndGet(admission, (n) => n + 1);
    yield* Queue.offer(mailbox, { _tag: "Message", derive, reply });
    return { admitted, reply };
  });

  const awaitReply = (reply: Deferred.Deferred<Committed<State>, Refusal>) =>
    Effect.raceFirst(Deferred.await(reply), Deferred.await(closed));

  const registry = yield* Effect.serviceOption(Inspection.Registry);
  if (Option.isSome(registry)) {
    const owner = yield* Inspection.ownerFor(registry.value);
    yield* registry.value.register(owner, (id) =>
      Effect.map(SubscriptionRef.get(committed), (current) => ({
        _tag: "Actor",
        id,
        ownerId: owner.id,
        parentOwnerId: owner.parentId,
        kind: "local",
        revision: current.revision,
      })),
    );
  }
  return {
    committed: fromSubscriptionRef(committed),
    isClosed: Ref.get(stopped),
    admit,
    awaitReply,
  } satisfies LocalEngine<State, Message, Refusal>;
});
