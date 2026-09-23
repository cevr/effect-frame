import { Unreachable } from "effect-frame/actor/client";
import type {
  Address,
  Projection,
  TransportReadError,
  TransportService,
} from "effect-frame/actor/client";
import { Effect, Stream } from "effect";

/**
 * The one transport shape a server-driven view draws with, on both sides of
 * the op wire (#87). The server's session and the client's drawing each build
 * theirs from this definition, so the two can never accept different inputs:
 * a view reads its drive actor and nothing else, and any other read fails
 * with the same `Unreachable` on the server and on the client.
 *
 * What differs between the sides is only what the drive serves, and whether
 * a command goes anywhere. On the server, a handler's command goes to the
 * real transport, because every handler runs there. On the client, nothing
 * is sent: the client draws, and its events cross the wire instead.
 *
 * Internal: not exported from a public entry.
 */

/** What the drive actor serves. */
export interface DriveReads {
  readonly snapshot: Effect.Effect<Projection, TransportReadError>;
  readonly changes: (after: number) => Stream.Stream<Projection, TransportReadError>;
}

/** Where a handler's command goes. */
export type DriveWrites = Pick<TransportService, "send" | "call">;

export const sameAddress = (a: Address, b: Address): boolean =>
  a.contract === b.contract && a.version === b.version && a.key === b.key;

const refused = (what: string) => Unreachable.make({ reason: `a server-driven view ${what}` });

/** Every command is refused: the drawing side sends nothing. */
export const sendsNothing: DriveWrites = {
  send: () => Effect.fail(refused("draws without sending")),
  call: () => Effect.fail(refused("draws without sending")),
};

export const driveOnly = (
  address: Address,
  reads: DriveReads,
  writes: DriveWrites,
): TransportService => ({
  snapshot: (asked) => {
    if (sameAddress(asked, address)) {
      return reads.snapshot;
    }
    return Effect.fail(refused("reads only its drive actor"));
  },
  changes: (asked, after) => {
    if (sameAddress(asked, address)) {
      return reads.changes(after);
    }
    return Stream.fail(refused("reads only its drive actor"));
  },
  send: writes.send,
  call: writes.call,
  query: () => Effect.fail(refused("reads no query")),
  queryBatch: () => Effect.fail(refused("reads no query")),
});
