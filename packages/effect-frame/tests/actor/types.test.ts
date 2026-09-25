import { Context, Effect, Option, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, test } from "bun:test";
import { Actor, Behavior as Behaviors, Refused } from "effect-frame/actor";
import type {
  ActorRef,
  ActorStopped,
  Applied,
  Behavior,
  CommandAdmitted,
  CommandApplied,
  CommandConflict,
  CommandHandle,
  CommandId,
  CommandRejected,
  CommandSent,
  CommandState,
  CommandUncertain,
  CommittedRevision,
  ContractMismatch,
  Displayed,
  IdentifiedCommandHandle,
  LocalActorRef,
  MailboxStore,
  Provisional,
  ProvisionalRevision,
  Rejection,
  SetValue,
  Unauthorized,
  Uncertain,
  UnknownContract,
} from "effect-frame/actor";
import { committedRevision, contract, resumeCodec } from "effect-frame/actor/client";
import type { QueryCacheService, RefOptions } from "effect-frame/actor/client";
import type * as Client from "effect-frame/actor/client";

/**
 * Compile-time checks. Placement is visible in the reference type: a local
 * command has no ID and is never uncertain; a durable or remote command has
 * an ID, a retry, and an Uncertain state. Only a committed revision is a
 * number a client may compare or resume from.
 */
declare const local: ActorRef<number, SetValue<number>, "local">;
declare const store: ActorRef<number, SetValue<number>, "durable">;
declare const wire: ActorRef<number, SetValue<number>, "remote">;
declare const message: SetValue<number>;
declare const commandId: CommandId;
declare const localHandle: CommandHandle<number, "local">;
declare const provisional: Provisional<number>;
declare const applied: Applied<number>;

type ValueOfSource<S> = S extends { readonly get: Effect.Effect<infer A> } ? A : never;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// A custom cache implements exactly this surface; ownership is not on it.
const queryCacheIsPublicOnly: Equals<
  keyof QueryCacheService,
  "open" | "active" | "apply" | "invalidate" | "principalChanged"
> = true;
// Command ownership is private: no public entry exports it.
// @ts-expect-error `CommandClaim` is not a public export.
export type _PrivateClaim = Client.CommandClaim;

const localCall = () => local.call(message);
const localSend = () => local.send(message);
const durableCall = () => store.call(message, { commandId, timeout: "1 second" });
const durableFreshCall = () => store.call(message, { timeout: "1 second" });
const durableSend = () => store.send(message, { commandId });
const durableFreshSend = () => store.send(message);
const wireCall = () => wire.call(message, { commandId, timeout: "1 second" });
const wireSend = () => wire.send(message);

const localCallErrorIsStoppedOnly: Equals<
  ReturnType<typeof localCall>,
  Effect.Effect<Applied<number>, ActorStopped>
> = true;

const localSendNeverFails: Equals<
  ReturnType<typeof localSend>,
  Effect.Effect<CommandHandle<number, "local">>
> = true;

const localStateCannotBeUncertain: Equals<
  CommandState<number, "local">,
  CommandAdmitted | CommandApplied<number> | CommandRejected<ActorStopped>
> = true;

const durableCallCanBeUncertain: Equals<
  ReturnType<typeof durableCall>,
  Effect.Effect<Applied<number>, ActorStopped | CommandConflict | Uncertain>
> = true;

const durableFreshCallIsTheSameType: Equals<
  ReturnType<typeof durableFreshCall>,
  ReturnType<typeof durableCall>
> = true;

const durableSendReturnsAnIdentifiedHandle: Equals<
  ReturnType<typeof durableSend>,
  Effect.Effect<IdentifiedCommandHandle<number, "durable">>
> = true;

const durableFreshSendIsTheSameType: Equals<
  ReturnType<typeof durableFreshSend>,
  ReturnType<typeof durableSend>
> = true;

const durableState: Equals<
  CommandState<number, "durable">,
  | CommandSent
  | CommandAdmitted
  | CommandApplied<number>
  | CommandRejected<ActorStopped | CommandConflict>
  | CommandUncertain
> = true;

const remoteCallReportsALostReplyAsUncertain: Equals<
  ReturnType<typeof wireCall>,
  Effect.Effect<
    Applied<number>,
    | ActorStopped
    | CommandConflict
    | Refused
    | Unauthorized
    | ContractMismatch
    | UnknownContract
    | Uncertain
  >
> = true;

const remoteSendReturnsAnIdentifiedHandle: Equals<
  ReturnType<typeof wireSend>,
  Effect.Effect<IdentifiedCommandHandle<number, "remote">>
> = true;

const remoteRejection: Equals<
  Rejection["remote"],
  ActorStopped | CommandConflict | Refused | Unauthorized | ContractMismatch | UnknownContract
> = true;

// A refusal is in the type only when the behavior has a `refuse` rule. A
// remote reference cannot see the host's behavior, so it always has one.
const refusing = Behaviors.reducer({
  initial: 0,
  reduce: (_state: number, next: SetValue<number>) => next.value,
  refuse: (next: SetValue<number>) =>
    Option.as(
      Option.liftPredicate(next, (sent) => sent.value < 0),
      Refused.make({ reason: "negative" }),
    ),
});
const spawnRefusing = () => Actor.local(refusing);
declare const refusingLocal: Effect.Success<ReturnType<typeof spawnRefusing>>;
const refusingLocalCall = () => refusingLocal.call(message);
const refusingLocalCallCanBeRefused: Equals<
  ReturnType<typeof refusingLocalCall>,
  Effect.Effect<Applied<number>, ActorStopped | Refused>
> = true;
const refusingLocalState: Equals<
  CommandState<number, "local", Refused>,
  CommandAdmitted | CommandApplied<number> | CommandRejected<ActorStopped | Refused>
> = true;
const durableRefusing = () =>
  Actor.durable({
    behavior: refusing,
    state: Schema.fromJsonString(Schema.Finite),
    message: Schema.fromJsonString(
      Schema.Struct({ _tag: Schema.tag("Set"), value: Schema.Finite }),
    ),
  });
declare const refusingStore: Effect.Success<ReturnType<typeof durableRefusing>>;
const refusingDurableCall = () => refusingStore.call(message, { commandId, timeout: "1 second" });
const refusingDurableCallCanBeRefused: Equals<
  ReturnType<typeof refusingDurableCall>,
  Effect.Effect<Applied<number>, ActorStopped | CommandConflict | Refused | Uncertain>
> = true;

const appliedIsCommitted: Equals<Applied<number>["revision"], CommittedRevision> = true;

// Requirements stay exact: the local engine adds only the scope, the durable
// engine adds the store, and neither adds a Crypto or Random service.
class Needed extends Context.Service<Needed, { readonly amount: number }>()(
  "effect-frame/tests/actor/types.test/Needed",
) {}
const needing: Behavior.Behavior<number, SetValue<number>, Needed> = {
  initial: 0,
  open: () =>
    Effect.gen(function* () {
      const needed = yield* Needed;
      return {
        apply: (_state: number, next: SetValue<number>) =>
          Effect.succeed(next.value + needed.amount),
        changes: Stream.empty,
      };
    }),
};
const spawnNeeding = () => Actor.local(needing);
const localRequirementsAreExact: Equals<
  Effect.Services<ReturnType<typeof spawnNeeding>>,
  Needed | Scope.Scope
> = true;
const localRefType: Equals<
  Effect.Success<ReturnType<typeof spawnNeeding>>,
  LocalActorRef<number, SetValue<number>>
> = true;
const durableNeeding = () =>
  Actor.durable({
    behavior: needing,
    state: Schema.fromJsonString(Schema.Finite),
    message: Schema.fromJsonString(
      Schema.Struct({ _tag: Schema.tag("Set"), value: Schema.Finite }),
    ),
  });
const durableRequirementsAreExact: Equals<
  Effect.Services<ReturnType<typeof durableNeeding>>,
  Needed | MailboxStore | Scope.Scope
> = true;

// @ts-expect-error a durable call requires a timeout
const _durableCallWithoutOptions = () => store.call(message);

// @ts-expect-error a local send takes no command options
const _localSendWithOptions = () => local.send(message, { commandId });

// @ts-expect-error a local handle has no command ID
const _localHandleId = () => localHandle.commandId;

// @ts-expect-error a local handle has no retry
const _localHandleRetry = () => localHandle.retry;

const _localUncertain = (state: CommandState<number, "local">) =>
  // @ts-expect-error a local command is never uncertain
  state._tag === "Uncertain";

// @ts-expect-error a committed revision is not a number to compare directly
const _compareRevision = () => applied.revision > 1;

const _provisionalAsCommitted = (): CommittedRevision =>
  // @ts-expect-error a provisional revision is never a committed revision
  provisional.revision;

const _provisionalAsApplied = (): Applied<number> =>
  // @ts-expect-error a provisional state is never an applied result
  provisional;

const Counter = contract("TypesCounter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Finite,
});

const _resumeProvisional = (): RefOptions<typeof Counter>["resume"] =>
  // @ts-expect-error resume data holds only a committed revision
  Option.some(provisional);

// What a remote reference shows can be provisional, so it is none of these.
const _displayedRevisionValue = (shown: Displayed<number>) =>
  // @ts-expect-error a displayed revision has no number until it is committed
  shown.revision.value > 1;

const _displayedAsApplied = (shown: Displayed<number>): Applied<number> =>
  // @ts-expect-error a displayed value is not an applied result
  shown;

const _resumeDisplayed = (shown: Displayed<number>): RefOptions<typeof Counter>["resume"] =>
  // @ts-expect-error resume data never comes from a displayed value
  Option.some(shown);

const remoteDisplays: Equals<ValueOfSource<typeof wire.displayed>, Displayed<number>> = true;
const remoteAppliedIsCommitted: Equals<ValueOfSource<typeof wire.applied>, Applied<number>> = true;

const _provisionalRevision: ProvisionalRevision = { _tag: "Provisional", base: 1, depth: 1 };

describe("reference types", () => {
  test("placement is visible in the type", () => {
    expect(localCallErrorIsStoppedOnly).toBe(true);
    expect(remoteDisplays).toBe(true);
    expect(remoteAppliedIsCommitted).toBe(true);
    expect(localSendNeverFails).toBe(true);
    expect(localStateCannotBeUncertain).toBe(true);
    expect(durableCallCanBeUncertain).toBe(true);
    expect(durableFreshCallIsTheSameType).toBe(true);
    expect(durableSendReturnsAnIdentifiedHandle).toBe(true);
    expect(durableFreshSendIsTheSameType).toBe(true);
    expect(durableState).toBe(true);
    expect(remoteCallReportsALostReplyAsUncertain).toBe(true);
    expect(remoteSendReturnsAnIdentifiedHandle).toBe(true);
    expect(remoteRejection).toBe(true);
    expect(refusingLocalCallCanBeRefused).toBe(true);
    expect(refusingLocalState).toBe(true);
    expect(refusingDurableCallCanBeRefused).toBe(true);
    expect(appliedIsCommitted).toBe(true);
    expect(localRequirementsAreExact).toBe(true);
    expect(localRefType).toBe(true);
    expect(durableRequirementsAreExact).toBe(true);
    expect(queryCacheIsPublicOnly).toBe(true);
  });

  test("resume data keeps a numeric revision on the wire and decodes it as committed", () => {
    const codec = resumeCodec(Counter);
    const decoded = Schema.decodeSync(codec)('{"revision":2,"state":5}');
    expect(decoded).toEqual({ revision: committedRevision(2), state: 5 });
    expect(Schema.encodeSync(codec)(decoded)).toBe('{"revision":2,"state":5}');
  });
});
