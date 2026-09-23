import { Effect, Schema } from "effect";
import { callThrough, identifiedHandle, suppliedId, toApplied } from "./command-handle.js";
import * as Commands from "./command-owner.js";
import { durableCommands } from "./durable-commands.js";
import {
  DurableHostConfig,
  type DurableEngineOptions,
  type DurableHostSettings,
  openDurable,
} from "./durable-engine.js";
import { select } from "./source.js";
import type {
  ActorRef,
  DurableCallOptions,
  DurableSendOptions,
  IdentifiedCommandHandle,
} from "./vocabulary.js";

/** The public durable actor options. The engine remains a private module. */
export type DurableOptions<State, Message, R> = DurableEngineOptions<State, Message, R>;

export { DurableHostConfig };
export type { DurableHostSettings };

/**
 * Spawn a durable actor over the `MailboxStore` in context. The public
 * adapter and hosted implementations both use the same private engine.
 *
 * Commands go through one private owner that lives in this scope. It retains
 * each unresolved command's ID and exact encoded bytes and runs the bounded
 * retry sequence on the construction context, not on the caller's fiber.
 */
export const durable = Effect.fn("Actor.durable")(function* <State, Message, R>(
  options: DurableOptions<State, Message, R>,
) {
  const engine = yield* openDurable(options);
  const owner = yield* Commands.make(durableCommands(engine));
  const encodeMessage = Schema.encodeEffect(options.message);
  const noKeys = Effect.succeed([]);
  const applied = select(engine.committed, toApplied);

  const send = Effect.fn("Actor.durable.send")(function* (
    message: Message,
    sendOptions: DurableSendOptions | void,
  ) {
    const identified = yield* Commands.identify(suppliedId(sendOptions));
    const owned = yield* owner.submit(identified, Effect.orDie(encodeMessage(message)), noKeys);
    return identifiedHandle(owned) satisfies IdentifiedCommandHandle<State, "durable">;
  });

  const call = Effect.fn("Actor.durable.call")(function* (
    message: Message,
    callOptions: DurableCallOptions,
  ) {
    const identified = yield* Commands.identify(suppliedId(callOptions));
    return yield* callThrough(
      owner.submit(identified, Effect.orDie(encodeMessage(message)), noKeys),
      identified.commandId,
      callOptions.timeout,
      owner.closed,
    );
  });

  const ref: ActorRef<State, Message, "durable"> = {
    kind: "durable",
    applied,
    // Nothing here predicts: the displayed value is the committed one.
    displayed: applied,
    state: select(applied, (committed) => committed.state),
    send,
    call,
  };
  return ref;
});
