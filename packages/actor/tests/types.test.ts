import type { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import type {
  ActorRef,
  ActorStopped,
  Applied,
  CommandConflict,
  DurableReceipt,
  RemoteFailure,
  SetValue,
  Uncertain,
} from "@effect-frame/actor";

/**
 * Compile-time checks. Placement is visible in the reference type: a local
 * reference cannot be uncertain and needs no command ID; a durable reference
 * requires both.
 */
declare const local: ActorRef<number, SetValue<number>, "local">;
declare const remote: ActorRef<number, SetValue<number>, "durable">;
declare const wire: ActorRef<number, SetValue<number>, "remote">;
declare const message: SetValue<number>;
declare const commandId: DurableReceipt["commandId"];

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const localCall = () => local.call(message);
const localSend = () => local.send(message);
const durableCall = () => remote.call(message, { commandId, timeout: "1 second" });
const durableSend = () => remote.send(message, { commandId });

const localCallErrorIsStoppedOnly: Equals<
  ReturnType<typeof localCall>,
  Effect.Effect<Applied<number>, ActorStopped>
> = true;

const localSendErrorIsStoppedOnly: Equals<
  ReturnType<typeof localSend>,
  Effect.Effect<{ readonly admitted: number }, ActorStopped>
> = true;

const durableCallCanBeUncertain: Equals<
  ReturnType<typeof durableCall>,
  Effect.Effect<Applied<number>, ActorStopped | CommandConflict | Uncertain>
> = true;

const durableSendCanConflict: Equals<
  ReturnType<typeof durableSend>,
  Effect.Effect<DurableReceipt, ActorStopped | CommandConflict>
> = true;

const wireCall = () => wire.call(message, { commandId, timeout: "1 second" });

const remoteCallAddsTransportFailures: Equals<
  ReturnType<typeof wireCall>,
  Effect.Effect<Applied<number>, ActorStopped | CommandConflict | Uncertain | RemoteFailure>
> = true;

// @ts-expect-error a durable call requires a command ID and a timeout
const _durableCallWithoutOptions = () => remote.call(message);

// @ts-expect-error a durable send requires a command ID
const _durableSendWithoutOptions = () => remote.send(message);

describe("reference types", () => {
  test("placement is visible in the type", () => {
    expect(localCallErrorIsStoppedOnly).toBe(true);
    expect(localSendErrorIsStoppedOnly).toBe(true);
    expect(durableCallCanBeUncertain).toBe(true);
    expect(durableSendCanConflict).toBe(true);
    expect(remoteCallAddsTransportFailures).toBe(true);
  });
});
