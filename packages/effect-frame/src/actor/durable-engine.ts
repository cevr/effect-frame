import type { Duration } from "effect";
import {
  Context,
  Deferred,
  Effect,
  Hash,
  Option,
  PubSub,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import * as Inspection from "../inspection.js";
import type { Behavior } from "./behavior.js";
import { refusalOf } from "./behavior.js";
import type { Committed } from "./engine-types.js";
import type { PendingCommand, StoredReceipt } from "./mailbox-store.js";
import { MailboxStore } from "./mailbox-store.js";
import { fromSubscriptionRef } from "./source.js";
import type { Source } from "./source.js";
import type { CommandConflict, CommandId, DurableReceipt, Refused } from "./vocabulary.js";
import { ActorStopped, Uncertain } from "./vocabulary.js";

export interface DurableEngineOptions<State, Message, R, Refusal extends Refused = never> {
  readonly behavior: Behavior<State, Message, R, Refusal>;
  /** Encodes the state to the string the mailbox stores. */
  readonly state: Schema.Codec<State, string>;
  /** Encodes a message at the durable boundary. */
  readonly message: Schema.Codec<Message, string>;
}

/** The private durable engine surface shared by the public and hosted adapters. */
export interface DurableEngine<State, Refusal = never> {
  readonly committed: Source<Committed<State>>;
  /** True once the engine scope has begun to close. */
  readonly isClosed: Effect.Effect<boolean>;
  /** Prepare one message inside the closed-aware admission boundary. */
  readonly sendPrepared: (
    commandId: CommandId,
    prepare: Effect.Effect<string>,
  ) => Effect.Effect<DurableReceipt, DurableAdmissionError<Refusal>>;
  /** Prepare and await one message inside the caller's timeout boundary. */
  readonly callPrepared: (
    commandId: CommandId,
    prepare: Effect.Effect<string>,
    timeout: Duration.Input,
  ) => Effect.Effect<Committed<State>, DurableAdmissionError<Refusal> | Uncertain>;
  /**
   * Submit a validated, prepared payload without running its encoder again.
   * A new command the behavior refuses is `Refused` and is not admitted; a
   * command this store already holds is answered from its record.
   */
  readonly sendEncoded: (
    commandId: CommandId,
    payload: string,
  ) => Effect.Effect<DurableReceipt, DurableAdmissionError<Refusal>>;
  /** Wait for the exact receipt of one prepared payload. */
  readonly callEncoded: (
    commandId: CommandId,
    payload: string,
    timeout: Duration.Input,
  ) => Effect.Effect<Committed<State>, DurableAdmissionError<Refusal> | Uncertain>;
}

/**
 * Why a durable engine does not admit one submission. `Refusal` is the
 * behavior's own refusal: `never` when it has no `refuse` rule.
 */
export type DurableAdmissionError<Refusal = never> = ActorStopped | CommandConflict | Refusal;

export interface DurableHostSettings {
  /** How long `call` sleeps between receipt polls when no early wake arrives. */
  readonly pollInterval: Duration.Input;
}

/**
 * Host tuning for durable actors. A host adapter supplies it. Application
 * code does not see it. The default suits an in-process store.
 */
export const DurableHostConfig = Context.Reference<DurableHostSettings>(
  "effect-frame/src/actor/durable/DurableHostConfig",
  { defaultValue: () => ({ pollInterval: "100 millis" }) },
);

type Wake<State> =
  | { readonly _tag: "Admitted" }
  | { readonly _tag: "Autonomous"; readonly state: State };

/**
 * The private durable engine. The public `durable` adapter and hosted
 * implementations both open this same engine, so one physical actor has one
 * behavior turn, mailbox worker, state source, and inspection registration.
 * The message codec is the prepared encoded boundary: an admitted payload is
 * stored once and can be decoded again after a restart without re-encoding it.
 */
export const openDurable = Effect.fn("Actor.durable.engine")(function* <
  State,
  Message,
  R,
  Refusal extends Refused = never,
>(options: DurableEngineOptions<State, Message, R, Refusal>) {
  const store = yield* MailboxStore;
  const host = yield* DurableHostConfig;
  const encodeState = Schema.encodeEffect(options.state);
  const decodeState = Schema.decodeEffect(options.state);
  const decodeMessage = Schema.decodeEffect(options.message);
  // Decode only for a behavior that has a rule: most refuse nothing.
  const refuses = Option.isSome(Option.fromNullishOr(options.behavior.refuse));

  const restored = yield* Effect.flatMap(store.latest, (latest) =>
    Option.match(latest, {
      onNone: () =>
        Effect.succeed<Committed<State>>({
          revision: 0,
          state: options.behavior.initial,
        }),
      onSome: (committed) =>
        Effect.map(Effect.orDie(decodeState(committed.state)), (state): Committed<State> => ({
          revision: committed.revision,
          state,
        })),
    }),
  );

  const turn = yield* options.behavior.open(restored.state);
  const committed = yield* SubscriptionRef.make(restored);
  const closed = yield* Deferred.make<never, ActorStopped>();
  const signal = yield* Queue.unbounded<Wake<State>>();
  const wake = yield* PubSub.unbounded<StoredReceipt>();
  // A behavior can emit the state it opened with. That is not a change: seed
  // the dedupe with the encoded state the actor started from, so a fresh
  // machine does not spend a revision on its initial state and a recovered
  // one does not spend a revision on the state it restored.
  const lastEncoded = yield* Ref.make(
    Option.some(yield* Effect.orDie(encodeState(restored.state))),
  );

  const processCommand = Effect.fn("Actor.durable.processCommand")(function* (
    command: PendingCommand,
  ) {
    const message = yield* Effect.orDie(decodeMessage(command.payload));
    const current = yield* SubscriptionRef.get(committed);
    const next = yield* turn.apply(current.state, message);
    const encoded = yield* Effect.orDie(encodeState(next));
    const receipt = yield* store.commit(command.commandId, encoded);
    yield* Ref.set(lastEncoded, Option.some(encoded));
    yield* SubscriptionRef.set(committed, { revision: receipt.revision, state: next });
    yield* PubSub.publish(wake, receipt);
  });

  const processAutonomous = Effect.fn("Actor.durable.processAutonomous")(function* (
    carried: State,
  ) {
    // A behavior that names its own state is read now: the carried value
    // can be older than a command committed since (see `Turn.current`).
    const changed = yield* Option.match(Option.fromNullishOr(turn.current), {
      onNone: () => Effect.succeed(carried),
      onSome: (current) => current,
    });
    const encoded = yield* Effect.orDie(encodeState(changed));
    const previous = yield* Ref.get(lastEncoded);
    if (Option.isSome(previous) && previous.value === encoded) {
      return;
    }
    const advanced = yield* store.advance(encoded);
    yield* Ref.set(lastEncoded, Option.some(encoded));
    yield* SubscriptionRef.set(committed, { revision: advanced.revision, state: changed });
  });

  /** Drain pending commands in admission order, then wait for the next wake. */
  const processNext = Effect.fn("Actor.durable.process")(function* () {
    const pending = yield* store.next;
    if (Option.isSome(pending)) {
      yield* processCommand(pending.value);
      return;
    }
    const woken = yield* Queue.take(signal);
    if (woken._tag === "Autonomous") {
      yield* processAutonomous(woken.state);
    }
  });

  yield* Effect.addFinalizer(() => Deferred.fail(closed, ActorStopped.make()));
  yield* Effect.forkScoped(Effect.forever(processNext()));
  yield* Effect.forkScoped(
    Stream.runForEach(turn.changes, (changed) =>
      Queue.offer(signal, { _tag: "Autonomous", state: changed }),
    ),
  );

  const toCommitted = Effect.fn("Actor.durable.toCommitted")(function* (receipt: StoredReceipt) {
    const decoded = yield* Effect.orDie(decodeState(receipt.state));
    return { revision: receipt.revision, state: decoded } satisfies Committed<State>;
  });

  /** Whether this store already holds a command with this ID, pending or committed. */
  const holds = (commandId: CommandId) =>
    Effect.flatMap(store.receipt(commandId), (receipt) => {
      if (Option.isSome(receipt)) {
        return Effect.succeed(true);
      }
      return Effect.map(store.pending, (pending) => pending.includes(commandId));
    });

  /**
   * Admission refusal (#37, #25 §1). The behavior's rule reads the message
   * alone, so the same bytes are refused every time and nothing is appended:
   * no admission, no revision. A command the store already holds is answered
   * from its record instead, so a same-ID retry never turns an admitted
   * command into a refused one.
   */
  const refuseNew = (commandId: CommandId, payload: string): Effect.Effect<void, Refusal> =>
    Effect.gen(function* () {
      if (!refuses) {
        return;
      }
      const message = yield* Effect.orDie(decodeMessage(payload));
      const refusal = refusalOf(options.behavior, message);
      if (Option.isNone(refusal) || (yield* holds(commandId))) {
        return;
      }
      return yield* refusal.value;
    });

  const sendEncoded = Effect.fn("Actor.durable.sendEncoded")(function* (
    commandId: CommandId,
    payload: string,
  ) {
    const isClosed = yield* Deferred.isDone(closed);
    if (isClosed) {
      return yield* ActorStopped.make();
    }
    yield* refuseNew(commandId, payload);
    const appended = yield* store.append({
      commandId,
      payload,
      payloadHash: Hash.string(payload),
    });
    if (appended._tag === "Admitted") {
      yield* Queue.offer(signal, { _tag: "Admitted" });
      return {
        commandId,
        admitted: appended.admitted,
        committed: Option.none(),
      } satisfies DurableReceipt;
    }
    return {
      commandId,
      admitted: appended.admitted,
      committed: Option.map(appended.receipt, (receipt) => receipt.revision),
    } satisfies DurableReceipt;
  });

  const sendPrepared = Effect.fn("Actor.durable.sendPrepared")(function* (
    commandId: CommandId,
    prepare: Effect.Effect<string>,
  ) {
    const isClosed = yield* Deferred.isDone(closed);
    if (isClosed) {
      return yield* ActorStopped.make();
    }
    const payload = yield* prepare;
    return yield* sendEncoded(commandId, payload);
  });

  const awaitReceipt = Effect.fn("Actor.durable.awaitReceipt")(function* (
    commandId: CommandId,
    subscription: PubSub.Subscription<StoredReceipt>,
  ) {
    const poll = Effect.fn("Actor.durable.poll")(function* () {
      const stored = yield* store.receipt(commandId);
      if (Option.isSome(stored)) {
        return stored;
      }
      yield* Effect.raceFirst(PubSub.take(subscription), Effect.sleep(host.pollInterval));
      return Option.none<StoredReceipt>();
    });
    const found = yield* Effect.repeat(poll(), { until: Option.isSome });
    const receipt = yield* Option.match(found, {
      onNone: () => Effect.die("Actor.durable.awaitReceipt: repeat ended without a receipt"),
      onSome: Effect.succeed,
    });
    // The store holds the receipt before this engine publishes the commit:
    // processCommand writes the store first. Reply only once `committed` has
    // reached the receipt, so a reader that follows the reply sees the
    // commit (read-your-writes). This engine is the store's one writer, so
    // the wait ends; the caller's timeout and `closed` bound it anyway.
    yield* Stream.runHead(
      Stream.filter(
        SubscriptionRef.changes(committed),
        (current) => current.revision >= receipt.revision,
      ),
    );
    return receipt;
  });

  const callEncoded = Effect.fn("Actor.durable.callEncoded")(function* (
    commandId: CommandId,
    payload: string,
    timeout: Duration.Input,
  ) {
    const wait = Effect.scopedWith((scope: Scope.Scope) =>
      Effect.gen(function* () {
        // Subscribe before admission. A fast commit must still wake this call,
        // while the store receipt remains the authority for the exact result.
        const subscription = yield* PubSub.subscribe(wake).pipe(Scope.provide(scope));
        yield* sendEncoded(commandId, payload);
        return yield* awaitReceipt(commandId, subscription);
      }),
    );
    const outcome = yield* Effect.raceFirst(
      Effect.timeoutOption(wait, timeout),
      Deferred.await(closed),
    );
    if (Option.isNone(outcome)) {
      return yield* Uncertain.make({ commandId });
    }
    return yield* toCommitted(outcome.value);
  });

  const callPrepared = Effect.fn("Actor.durable.callPrepared")(function* (
    commandId: CommandId,
    prepare: Effect.Effect<string>,
    timeout: Duration.Input,
  ) {
    const wait = Effect.scopedWith((scope: Scope.Scope) =>
      Effect.gen(function* () {
        // Subscribe before preparation. The closed check below prevents a
        // stopped actor from starting a codec, while the second check in
        // sendEncoded closes the race after an asynchronous codec completes.
        const subscription = yield* PubSub.subscribe(wake).pipe(Scope.provide(scope));
        const isClosed = yield* Deferred.isDone(closed);
        if (isClosed) {
          return yield* ActorStopped.make();
        }
        const payload = yield* prepare;
        yield* sendEncoded(commandId, payload);
        return yield* awaitReceipt(commandId, subscription);
      }),
    );
    const outcome = yield* Effect.raceFirst(
      Effect.timeoutOption(wait, timeout),
      Deferred.await(closed),
    );
    if (Option.isNone(outcome)) {
      return yield* Uncertain.make({ commandId });
    }
    return yield* toCommitted(outcome.value);
  });

  const committedSource = fromSubscriptionRef(committed);

  const registry = yield* Effect.serviceOption(Inspection.Registry);
  if (Option.isSome(registry)) {
    const owner = yield* Inspection.ownerFor(registry.value);
    yield* registry.value.register(owner, (id) =>
      Effect.map(SubscriptionRef.get(committed), (current) => ({
        _tag: "Actor",
        id,
        ownerId: owner.id,
        parentOwnerId: owner.parentId,
        kind: "durable",
        revision: current.revision,
      })),
    );
  }
  return {
    committed: committedSource,
    isClosed: Deferred.isDone(closed),
    sendPrepared,
    callPrepared,
    sendEncoded,
    callEncoded,
  } satisfies DurableEngine<State, Refusal>;
});
