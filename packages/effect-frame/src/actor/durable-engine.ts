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
import type { PendingCommand, StoredReceipt } from "./mailbox-store.js";
import { MailboxStore } from "./mailbox-store.js";
import { fromSubscriptionRef } from "./source.js";
import type { Source } from "./source.js";
import type { Applied, CommandConflict, CommandId, DurableReceipt } from "./vocabulary.js";
import { ActorStopped, Uncertain } from "./vocabulary.js";

export interface DurableEngineOptions<State, Message, R> {
  readonly behavior: Behavior<State, Message, R>;
  /** Encodes the state to the string the mailbox stores. */
  readonly state: Schema.Codec<State, string>;
  /** Encodes a message at the durable boundary. */
  readonly message: Schema.Codec<Message, string>;
}

/** The private durable engine surface shared by the public and hosted adapters. */
export interface DurableEngine<State, Message> {
  readonly applied: Source<Applied<State>>;
  readonly send: (
    message: Message,
    options: { readonly commandId: CommandId },
  ) => Effect.Effect<DurableReceipt, ActorStopped | CommandConflict>;
  readonly call: (
    message: Message,
    options: { readonly commandId: CommandId; readonly timeout: Duration.Input },
  ) => Effect.Effect<Applied<State>, ActorStopped | CommandConflict | Uncertain>;
  /** Submit a validated, prepared payload without running its encoder again. */
  readonly sendEncoded: (
    commandId: CommandId,
    payload: string,
  ) => Effect.Effect<DurableReceipt, ActorStopped | CommandConflict>;
  /** Wait for the exact receipt of one prepared payload. */
  readonly callEncoded: (
    commandId: CommandId,
    payload: string,
    timeout: Duration.Input,
  ) => Effect.Effect<Applied<State>, ActorStopped | CommandConflict | Uncertain>;
}

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
export const openDurable = Effect.fn("Actor.durable.engine")(function* <State, Message, R>(
  options: DurableEngineOptions<State, Message, R>,
) {
  const store = yield* MailboxStore;
  const host = yield* DurableHostConfig;
  const encodeState = Schema.encodeEffect(options.state);
  const decodeState = Schema.decodeEffect(options.state);
  const encodeMessage = Schema.encodeEffect(options.message);
  const decodeMessage = Schema.decodeEffect(options.message);

  const restored = yield* Effect.flatMap(store.latest, (latest) =>
    Option.match(latest, {
      onNone: () =>
        Effect.succeed<Applied<State>>({
          revision: 0,
          state: options.behavior.initial,
        }),
      onSome: (committed) =>
        Effect.map(Effect.orDie(decodeState(committed.state)), (state): Applied<State> => ({
          revision: committed.revision,
          state,
        })),
    }),
  );

  const turn = yield* options.behavior.open(restored.state);
  const applied = yield* SubscriptionRef.make(restored);
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
    const current = yield* SubscriptionRef.get(applied);
    const next = yield* turn.apply(current.state, message);
    const encoded = yield* Effect.orDie(encodeState(next));
    const receipt = yield* store.commit(command.commandId, encoded);
    yield* Ref.set(lastEncoded, Option.some(encoded));
    yield* SubscriptionRef.set(applied, { revision: receipt.revision, state: next });
    yield* PubSub.publish(wake, receipt);
  });

  const processAutonomous = Effect.fn("Actor.durable.processAutonomous")(function* (
    changed: State,
  ) {
    const encoded = yield* Effect.orDie(encodeState(changed));
    const previous = yield* Ref.get(lastEncoded);
    if (Option.isSome(previous) && previous.value === encoded) {
      return;
    }
    const committed = yield* store.advance(encoded);
    yield* Ref.set(lastEncoded, Option.some(encoded));
    yield* SubscriptionRef.set(applied, { revision: committed.revision, state: changed });
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

  const toApplied = Effect.fn("Actor.durable.toApplied")(function* (receipt: StoredReceipt) {
    const decoded = yield* Effect.orDie(decodeState(receipt.state));
    return { revision: receipt.revision, state: decoded } satisfies Applied<State>;
  });

  const sendEncoded = Effect.fn("Actor.durable.sendEncoded")(function* (
    commandId: CommandId,
    payload: string,
  ) {
    const isClosed = yield* Deferred.isDone(closed);
    if (isClosed) {
      return yield* ActorStopped.make();
    }
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

  const send = Effect.fn("Actor.durable.send")(function* (
    message: Message,
    sendOptions: { readonly commandId: CommandId },
  ) {
    const payload = yield* Effect.orDie(encodeMessage(message));
    return yield* sendEncoded(sendOptions.commandId, payload);
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
    return yield* Option.match(found, {
      onNone: () => Effect.die("Actor.durable.awaitReceipt: repeat ended without a receipt"),
      onSome: Effect.succeed,
    });
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
    return yield* toApplied(outcome.value);
  });

  const call = Effect.fn("Actor.durable.call")(function* (
    message: Message,
    callOptions: { readonly commandId: CommandId; readonly timeout: Duration.Input },
  ) {
    const payload = yield* Effect.orDie(encodeMessage(message));
    return yield* callEncoded(callOptions.commandId, payload, callOptions.timeout);
  });

  const appliedSource = fromSubscriptionRef(applied);

  const registry = yield* Effect.serviceOption(Inspection.Registry);
  if (Option.isSome(registry)) {
    const owner = yield* Inspection.ownerFor(registry.value);
    yield* registry.value.register(owner, (id) =>
      Effect.map(SubscriptionRef.get(applied), (current) => ({
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
    applied: appliedSource,
    send,
    call,
    sendEncoded,
    callEncoded,
  } satisfies DurableEngine<State, Message>;
});
