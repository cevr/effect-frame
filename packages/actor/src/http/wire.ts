import { Schema } from "effect";
import {
  ActorStopped,
  CommandConflict,
  CommandId,
  ContractMismatch,
  Unauthorized,
  Uncertain,
  UnknownContract,
  Unreachable,
} from "../vocabulary.js";

/**
 * The HTTP shape of the actor transport. Both sides import this module and
 * nothing else from the other side. Every body is JSON; `changes` is a
 * server-sent event stream with one `data:` line per revision.
 *
 *   POST {base}/send      SendBody     -> WireReceipt | WireError
 *   POST {base}/call      CallBody     -> WireProjection | WireError
 *   POST {base}/snapshot  AddressBody  -> WireProjection | WireError
 *   GET  {base}/changes?contract&version&key&after -> text/event-stream
 */
export const WireAddress = Schema.Struct({
  contract: Schema.String,
  version: Schema.Finite,
  key: Schema.String,
});

export const AddressBody = Schema.Struct({ address: WireAddress });

export const SendBody = Schema.Struct({
  address: WireAddress,
  commandId: CommandId,
  payload: Schema.String,
});

export const CallBody = Schema.Struct({
  address: WireAddress,
  commandId: CommandId,
  payload: Schema.String,
  timeoutMillis: Schema.Finite,
});

export const WireReceipt = Schema.Struct({
  commandId: CommandId,
  admitted: Schema.Finite,
  committed: Schema.OptionFromNullOr(Schema.Finite),
});

export const WireProjection = Schema.Struct({
  revision: Schema.Finite,
  snapshot: Schema.String,
});

export const WireError = Schema.Union([
  ActorStopped,
  CommandConflict,
  Uncertain,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);
export type WireError = Schema.Schema.Type<typeof WireError>;

/** What each verb may fail with. A server that returns anything else broke the protocol. */
export const SendWireError = Schema.Union([
  ActorStopped,
  CommandConflict,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);
export const CallWireError = Schema.Union([
  ActorStopped,
  CommandConflict,
  Uncertain,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);
export const ReadWireError = Schema.Union([
  ActorStopped,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);

export const statusOf = (error: WireError): number => {
  switch (error._tag) {
    case "Unauthorized":
      return 403;
    case "UnknownContract":
      return 404;
    case "CommandConflict":
    case "ContractMismatch":
      return 409;
    case "Uncertain":
      return 504;
    case "ActorStopped":
      return 503;
    case "Unreachable":
      return 502;
  }
};

export const paths = {
  send: "/send",
  call: "/call",
  snapshot: "/snapshot",
  changes: "/changes",
} satisfies Record<string, string>;

export const eventPrefix = "data: ";
