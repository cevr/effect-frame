import type { Duration, Effect, Option } from "effect";
import { Schema } from "effect";
import type { Source } from "./source.js";

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

/**
 * A revision the actor committed: a point on its monotonic clock. Only a
 * committed revision has a number a client may compare, store, or resume from.
 */
export const CommittedRevision = Schema.TaggedStruct("Committed", { value: Schema.Finite });
export type CommittedRevision = Schema.Schema.Type<typeof CommittedRevision>;

/**
 * A client-side guess computed over a committed base. It has no number of its
 * own, so it cannot be compared with a committed revision, used as a changes
 * cursor, or written into resume data. Prediction produces it; an opaque
 * reference never does.
 */
export const ProvisionalRevision = Schema.TaggedStruct("Provisional", {
  /** The committed revision this guess was computed from. */
  base: Schema.Finite,
  /** How many provisional commands deep the guess is. 1 is the first. */
  depth: Schema.Finite,
});
export type ProvisionalRevision = Schema.Schema.Type<typeof ProvisionalRevision>;

export type Revision = CommittedRevision | ProvisionalRevision;

export const committedRevision = (value: number): CommittedRevision => ({
  _tag: "Committed",
  value,
});

/** The committed result of one processed message, or a committed observation. */
export interface Applied<State> {
  readonly revision: CommittedRevision;
  readonly state: State;
}

/** A predicted state over a committed base. Never a committed result. */
export interface Provisional<State> {
  readonly revision: ProvisionalRevision;
  readonly state: State;
}

/**
 * Acceptance of a durable command by a mailbox, as the protocol reports it.
 * `committed` is present when the mailbox already holds a receipt for this
 * command ID. Revisions on the protocol stay numeric and committed-only.
 */
export interface DurableReceipt {
  readonly commandId: CommandId;
  readonly admitted: number;
  readonly committed: Option.Option<number>;
}

/** The caller may not act on this actor. Raised by the transport, never locally. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  contract: Schema.String,
}) {}

/** No implementation is registered for this contract name. */
export class UnknownContract extends Schema.TaggedError<UnknownContract>()("UnknownContract", {
  contract: Schema.String,
}) {}

/** The client and server contracts differ in version. */
export class ContractMismatch extends Schema.TaggedError<ContractMismatch>()("ContractMismatch", {
  contract: Schema.String,
  expected: Schema.Finite,
  actual: Schema.Finite,
}) {}

/** The host could not be reached or answered outside the protocol. */
export class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", {
  reason: Schema.String,
}) {}

/** Failures only a transport can raise. */
export type RemoteFailure = Unauthorized | ContractMismatch | UnknownContract | Unreachable;

/**
 * `local`: same process, no mailbox store. `durable`: this process over a
 * mailbox store. `remote`: another process reached through a transport.
 */
export type ActorKind = "local" | "durable" | "remote";

export interface DurableSendOptions {
  /**
   * Omit it and the framework mints a secure fresh ID. A supplied ID is
   * treated as possibly admitted already, whatever its string looks like.
   */
  readonly commandId?: CommandId;
}

export interface DurableCallOptions extends DurableSendOptions {
  readonly timeout: Duration.Input;
}

export interface SendOptions {
  readonly local: void;
  readonly durable: DurableSendOptions | void;
  readonly remote: DurableSendOptions | void;
}

export interface CallOptions {
  readonly local: void;
  readonly durable: DurableCallOptions;
  readonly remote: DurableCallOptions;
}

/**
 * Why one submission will never apply. Every case is conclusive for that
 * submission. `Unreachable` is not here: a lost reply is uncertainty.
 */
export interface Rejection {
  readonly local: ActorStopped;
  readonly durable: ActorStopped | CommandConflict;
  readonly remote:
    | ActorStopped
    | CommandConflict
    | Unauthorized
    | ContractMismatch
    | UnknownContract;
}

/**
 * A `call` either returns the committed result, fails with the conclusive
 * refusal, or ends its wait with `Uncertain`. A local call cannot be
 * uncertain. A remote call reports a lost reply as `Uncertain`, not as
 * `Unreachable`: the command may still commit.
 */
export interface CallError {
  readonly local: ActorStopped;
  readonly durable: Rejection["durable"] | Uncertain;
  readonly remote: Rejection["remote"] | Uncertain;
}

// ---------------------------------------------------------------------------
// Command lifecycle
// ---------------------------------------------------------------------------

/** Submitted on this client. No admission is known yet. */
export interface CommandSent {
  readonly _tag: "Sent";
}

/** The mailbox holds the command at this admission position. */
export interface CommandAdmitted {
  readonly _tag: "Admitted";
  readonly admitted: number;
}

/** The exact committed result of this command, from its own receipt. */
export interface CommandApplied<State> {
  readonly _tag: "Applied";
  readonly admitted: number;
  readonly revision: CommittedRevision;
  readonly state: State;
}

/** A conclusive refusal. This submission will never apply. */
export interface CommandRejected<Reason> {
  readonly _tag: "Rejected";
  readonly reason: Reason;
}

/**
 * The command may still commit. Not terminal. `attempt` is the pass that
 * last ended without evidence; 8 means the automatic bound was reached.
 */
export interface CommandUncertain {
  readonly _tag: "Uncertain";
  readonly attempt: number;
  readonly admitted: Option.Option<number>;
}

/** The lifecycle each placement can reach. A local command is never uncertain. */
export interface CommandStates<State> {
  readonly local: CommandAdmitted | CommandApplied<State> | CommandRejected<Rejection["local"]>;
  readonly durable:
    | CommandSent
    | CommandAdmitted
    | CommandApplied<State>
    | CommandRejected<Rejection["durable"]>
    | CommandUncertain;
  readonly remote:
    | CommandSent
    | CommandAdmitted
    | CommandApplied<State>
    | CommandRejected<Rejection["remote"]>
    | CommandUncertain;
}

export type CommandState<State, Kind extends ActorKind> = CommandStates<State>[Kind];

/** The first terminal state. Rejection stays in the value. */
export type CommandSettled<State, Kind extends ActorKind> =
  | CommandApplied<State>
  | CommandRejected<Rejection[Kind]>;

/**
 * One submitted command. `state` is available before any reply lands.
 * `settled` waits for the first terminal state; the caller owns that wait,
 * and an uncertain command may never settle.
 */
export interface CommandHandle<State, Kind extends ActorKind> {
  readonly state: Source<CommandState<State, Kind>>;
  readonly settled: Effect.Effect<CommandSettled<State, Kind>>;
}

/**
 * A durable or remote command. Its ID and exact encoded bytes are retained
 * while it is unresolved. `retry` starts one new bounded sequence with the
 * same ID and bytes; it joins running work and does nothing once terminal or
 * after its reference closes.
 */
export interface IdentifiedCommandHandle<
  State,
  Kind extends "durable" | "remote",
> extends CommandHandle<State, Kind> {
  readonly commandId: CommandId;
  readonly retry: Effect.Effect<void>;
}

export interface CommandHandles<State> {
  readonly local: CommandHandle<State, "local">;
  readonly durable: IdentifiedCommandHandle<State, "durable">;
  readonly remote: IdentifiedCommandHandle<State, "remote">;
}

/**
 * One reference type for local, durable, and remote actors. `Kind` selects
 * the option, handle, and error types, so placement is visible in the type.
 * `send` never fails: it returns a handle once the command is allocated
 * locally, and every refusal is a state of that handle.
 */
export interface ActorRef<State, Message, Kind extends ActorKind> {
  readonly kind: Kind;
  /** The latest committed revision this reference observed, with its state. */
  readonly applied: Source<Applied<State>>;
  /** The latest observed state. A projection of `applied`. */
  readonly state: Source<State>;
  readonly send: (
    message: Message,
    options: SendOptions[Kind],
  ) => Effect.Effect<CommandHandles<State>[Kind]>;
  readonly call: (
    message: Message,
    options: CallOptions[Kind],
  ) => Effect.Effect<Applied<State>, CallError[Kind]>;
}
