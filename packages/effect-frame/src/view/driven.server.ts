import { ActorTransport } from "effect-frame/actor/client";
import type { AnyContract } from "effect-frame/actor/client";
import { Deferred, Effect, Exit, Option, Schema, Scope, Stream } from "effect";
import { driveOnly } from "./drive-transport.js";
import * as Remote from "./hosts/remote.js";
import { mountView } from "./runtime.js";
import type { View } from "./view.js";
import type { ScopesClosed } from "./readiness.js";

/**
 * The server half of a server-driven view (#15, #27). A session is one
 * connected client: the view mounted on a fresh recorder at the drive
 * actor's latest snapshot, and nothing else. A reconnect is a new session.
 *
 * Server only: a browser entry never reaches this module. The client half is
 * `Remote` on `effect-frame/view`.
 */

/**
 * The client stopped taking patches, and the operations waiting for it
 * passed the session's limit. The session dropped them and closed its
 * mount: the client must resume from a new session's snapshot.
 */
export class Backlogged extends Schema.TaggedError<Backlogged>()("Backlogged", {
  limit: Schema.Int,
}) {}

/** The most operations a session holds for a client that does not take them. */
export const defaultLimit = 10_000;

export interface SessionOptions {
  /** See `defaultLimit`. */
  readonly limit?: number;
}

/** What one session holds. After its scope closes, every figure is zero. */
export interface Retained extends Remote.Retained {
  /** The session still holds the snapshot it mounted from. */
  readonly snapshot: boolean;
}

export interface Session {
  /**
   * The first message to the client: the session's id, the drive's snapshot,
   * from which the client draws the tree this session's recorder drew, and
   * the digest of that drawing. It costs the snapshot, never the first-mount
   * op log, and it is the same size for a client of any age.
   */
  readonly resume: string;
  /**
   * Every later change, in order, from position 0, each patch naming this
   * session. A patch is cut once the drawing is whole. One subscriber reads
   * it: the connection. It fails with `Backlogged` when the client falls too
   * far behind.
   */
  readonly patches: Stream.Stream<Remote.Patch, Backlogged>;
  /** Run the handler a client's event names, if a drained patch gave it. */
  readonly fire: (event: Remote.RemoteEvent) => Effect.Effect<void>;
  readonly retained: Effect.Effect<Retained>;
}

/**
 * Open a session for one client. The view mounts on a fresh recorder, with
 * the drive's snapshot read once and pinned for that mount, and the drive's
 * changes held back until the first drawing is drained, so the drawing is
 * exactly the one the client makes from `resume`. The changes then start
 * from the pinned revision, so none is lost. The view reads its drive and
 * nothing else, as the client's drawing does; a handler's command goes to
 * the real transport.
 *
 * The first-mount operations are drained and dropped: the client draws them
 * itself. The recorder releases its shadow when the scope closes. The
 * session keeps no operation after it is drained.
 */
export const session = Effect.fn("Driven.session")(function* <Props, E, R, C extends AnyContract>(
  view: View<Props, E, R> & ScopesClosed<R>,
  props: Props,
  drive: Remote.Drive<C>,
  options: SessionOptions = {},
) {
  const limit = options.limit ?? defaultLimit;
  const transport = yield* ActorTransport;
  const address = yield* Remote.addressOf(drive);
  // A session id is fresh for each session, from the platform's secure
  // source, never the application's `Random` service, which a test may seed.
  // oxlint-disable-next-line effect/noGlobals -- native secure UUID source at the platform boundary
  const id = crypto.randomUUID();
  const first = yield* transport.snapshot(address);
  let pinned = Option.some(first);
  const drawn = yield* Deferred.make<void>();

  const mountTransport = driveOnly(
    address,
    {
      snapshot: Effect.suspend(() =>
        Option.match(pinned, {
          onNone: () => transport.snapshot(address),
          onSome: (projection) => Effect.succeed(projection),
        }),
      ),
      changes: (after) =>
        Stream.unwrap(Effect.as(Deferred.await(drawn), transport.changes(address, after))),
    },
    transport,
  );

  const recording = Remote.recorder({ limit });
  // Added before the mount's scope, so it runs after the mount's own release.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      pinned = Option.none();
      recording.release();
    }),
  );
  const mountScope = yield* Scope.fork(yield* Effect.scope);
  yield* mountView(view, props, recording.host, Remote.root).pipe(
    Effect.provideService(ActorTransport, mountTransport),
    Scope.provide(mountScope),
  );
  yield* recording.settled;
  const resume = yield* Effect.orDie(Remote.payloadOf(id, first, recording.drain()));
  pinned = Option.none();
  yield* Deferred.done(drawn, Exit.void);

  // A client that stops taking patches costs the limit, not the backlog.
  yield* Effect.forkScoped(
    recording.overflowed.pipe(
      Effect.andThen(Scope.close(mountScope, Exit.void)),
      Effect.andThen(Effect.sync(() => recording.release())),
    ),
  );

  let position = 0;
  const backlogged = Effect.suspend(() => {
    if (recording.isOverflowed()) {
      return Effect.fail(Backlogged.make({ limit }));
    }
    return Effect.void;
  });
  const next = Effect.gen(function* () {
    yield* recording.pending;
    yield* backlogged;
    yield* recording.settled;
    yield* backlogged;
    const patch: Remote.Patch = {
      session: id,
      from: position,
      to: position + 1,
      ops: recording.drain(),
    };
    position = patch.to;
    return patch;
  });

  const opened: Session = {
    resume,
    patches: Stream.fromEffectRepeat(next),
    fire: (event) => Effect.sync(() => recording.fire(event)),
    retained: Effect.sync(() => ({ ...recording.retained(), snapshot: Option.isSome(pinned) })),
  };
  return opened;
});
