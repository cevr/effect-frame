import type { Duration } from "effect";
import {
  Deferred,
  Effect,
  Hash,
  Option,
  PubSub,
  Queue,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect";
import type { ActorRef, Applied, CommandId, DurableReceipt } from "./actor.js";
import { ActorStopped, Uncertain } from "./actor.js";
import type { Behavior } from "./behavior.js";
import type { StoredReceipt } from "./mailbox-store.js";
import { MailboxStore } from "./mailbox-store.js";
import { fromSubscriptionRef } from "./source.js";

export interface DurableOptions<State, Message, R> {
  readonly behavior: Behavior<State, Message, R>;
  /** Encodes the state to the string the mailbox stores. */
  readonly state: Schema.Codec<State, string>;
  /** Encodes a message to the string the mailbox stores. */
  readonly message: Schema.Codec<Message, string>;
  /** How long `call` sleeps between receipt polls when no wake arrives. */
  readonly pollInterval: Duration.Input;
}

/**
 * Spawn a durable actor over the `MailboxStore` in context. On start it
 * restores the committed state, then drains every pending command in
 * admission order before it waits for new ones. Each command commits its
 * next state and receipt in one store step before anyone observes it.
 */
export const durable = Effect.fn("Actor.durable")(function* <State, Message, R>(
  options: DurableOptions<State, Message, R>,
) {
  const store = yield* MailboxStore;
  const encodeState = Schema.encodeEffect(options.state);
  const decodeState = Schema.decodeEffect(options.state);
  const encodeMessage = Schema.encodeEffect(options.message);
  const decodeMessage = Schema.decodeEffect(options.message);

  const restored = yield* Effect.flatMap(store.latest, (latest) =>
    Option.match(latest, {
      onNone: () => Effect.succeed(options.behavior.initial),
      onSome: (committed) => Effect.orDie(decodeState(committed.state)),
    }),
  );

  const turn = yield* options.behavior.open(restored);
  const state = yield* SubscriptionRef.make(restored);
  const closed = yield* Deferred.make<never, ActorStopped>();
  const signal = yield* Queue.unbounded<number>();
  const wake = yield* PubSub.unbounded<StoredReceipt>();

  const processNext = Effect.fn("Actor.durable.process")(function* () {
    const pending = yield* store.next;
    if (Option.isNone(pending)) {
      yield* Queue.take(signal);
      return;
    }
    const command = pending.value;
    const message = yield* Effect.orDie(decodeMessage(command.payload));
    const current = yield* SubscriptionRef.get(state);
    const next = yield* turn.apply(current, message);
    const encoded = yield* Effect.orDie(encodeState(next));
    const receipt = yield* store.commit(command.commandId, encoded);
    yield* SubscriptionRef.set(state, next);
    yield* PubSub.publish(wake, receipt);
  });

  yield* Effect.addFinalizer(() => Deferred.fail(closed, ActorStopped.make()));
  yield* Effect.forkScoped(Effect.forever(processNext()));

  const toApplied = Effect.fn("Actor.durable.toApplied")(function* (receipt: StoredReceipt) {
    const decoded = yield* Effect.orDie(decodeState(receipt.state));
    return { revision: receipt.revision, state: decoded } satisfies Applied<State>;
  });

  const send = Effect.fn("Actor.durable.send")(function* (
    message: Message,
    sendOptions: { readonly commandId: CommandId },
  ) {
    const isClosed = yield* Deferred.isDone(closed);
    if (isClosed) {
      return yield* ActorStopped.make();
    }
    const payload = yield* Effect.orDie(encodeMessage(message));
    const appended = yield* store.append({
      commandId: sendOptions.commandId,
      payload,
      payloadHash: Hash.string(payload),
    });
    if (appended._tag === "Admitted") {
      yield* Queue.offer(signal, appended.admitted);
      return {
        commandId: sendOptions.commandId,
        admitted: appended.admitted,
        committed: Option.none(),
      } satisfies DurableReceipt;
    }
    return {
      commandId: sendOptions.commandId,
      admitted: appended.admitted,
      committed: Option.map(appended.receipt, (receipt) => receipt.revision),
    } satisfies DurableReceipt;
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
      yield* Effect.raceFirst(PubSub.take(subscription), Effect.sleep(options.pollInterval));
      return Option.none<StoredReceipt>();
    });
    const found = yield* Effect.repeat(poll(), { until: Option.isSome });
    return yield* Option.match(found, {
      onNone: () => Effect.die("Actor.durable.awaitReceipt: repeat ended without a receipt"),
      onSome: Effect.succeed,
    });
  });

  const call = Effect.fn("Actor.durable.call")(function* (
    message: Message,
    callOptions: { readonly commandId: CommandId; readonly timeout: Duration.Input },
  ) {
    const wait = Effect.scopedWith((scope: Scope.Scope) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(wake).pipe(Scope.provide(scope));
        yield* send(message, { commandId: callOptions.commandId });
        return yield* awaitReceipt(callOptions.commandId, subscription);
      }),
    );
    const outcome = yield* Effect.raceFirst(
      Effect.timeoutOption(wait, callOptions.timeout),
      Deferred.await(closed),
    );
    if (Option.isNone(outcome)) {
      return yield* Uncertain.make({ commandId: callOptions.commandId });
    }
    return yield* toApplied(outcome.value);
  });

  const ref: ActorRef<State, Message, "durable"> = {
    kind: "durable",
    state: fromSubscriptionRef(state),
    send,
    call,
  };
  return ref;
});
