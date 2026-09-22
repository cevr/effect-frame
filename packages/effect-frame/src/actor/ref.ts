import { Effect, Option, Schema, Stream, SubscriptionRef } from "effect";
import { callThrough, identifiedHandle, suppliedId, toApplied } from "./command-handle.js";
import * as Commands from "./command-owner.js";
import type { Committed } from "./engine-types.js";
import { remoteCommands } from "./remote-commands.js";
import type { RemoteRejection } from "./remote-commands.js";
import type { Address, AnyContract, KeyOf, MessageOf, SnapshotOf } from "./contract.js";
import type { QueryKey } from "./query.js";
import { QueryCache } from "./query-client.js";
import { fromSubscriptionRef, select } from "./source.js";
import type { Projection, TransportReadError } from "./transport.js";
import { ActorTransport } from "./transport.js";
import type {
  ActorRef,
  Applied,
  DurableCallOptions,
  DurableSendOptions,
  IdentifiedCommandHandle,
} from "./vocabulary.js";

export type RemoteActorRef<C extends AnyContract> = ActorRef<SnapshotOf<C>, MessageOf<C>, "remote">;

export interface RefOptions<C extends AnyContract> {
  /**
   * A snapshot the client already holds, for example one rendered into the
   * page by the server. The reference starts from it and subscribes to the
   * revisions after it. `None` fetches the latest snapshot first.
   */
  readonly resume: Option.Option<Applied<SnapshotOf<C>>>;
}

const fetchInitial = <C extends AnyContract>(
  contract: C,
  address: Address,
  options: RefOptions<C>,
): Effect.Effect<Committed<SnapshotOf<C>>, TransportReadError, ActorTransport> =>
  Option.match(options.resume, {
    onSome: (resumed) =>
      Effect.succeed<Committed<SnapshotOf<C>>>({
        revision: resumed.revision.value,
        state: resumed.state,
      }),
    onNone: () =>
      Effect.gen(function* () {
        const transport = yield* ActorTransport;
        const projection = yield* transport.snapshot(address);
        return yield* decodeProjection(contract, projection);
      }),
  });

const decodeProjection = <C extends AnyContract>(
  contract: C,
  projection: Projection,
): Effect.Effect<Committed<SnapshotOf<C>>> =>
  Effect.map(
    Effect.orDie(Schema.decodeEffect(contract.snapshot)(projection.snapshot)),
    (state): Committed<SnapshotOf<C>> => ({ revision: projection.revision, state }),
  );

/** Revisions arrive from two paths (subscription and call); keep the newest. */
const newest = <A>(current: Committed<A>, next: Committed<A>): Committed<A> => {
  if (next.revision > current.revision) {
    return next;
  }
  return current;
};

/**
 * A client-side reference to an actor hosted elsewhere. The client holds the
 * contract, the key, and a transport. It never holds the behavior. `state`
 * is the latest snapshot the transport delivered; `applied` carries its
 * committed revision so a later reference can resume without a gap.
 *
 * Commands go through one private owner in this scope. `send` returns an
 * identified handle at once; the owner runs one send and one same-ID call per
 * pass, retries a lost pass within its bound, and keeps the exact bytes
 * while the command is unresolved.
 */
export const ref = Effect.fn("Actor.ref")(function* <C extends AnyContract>(
  contract: C,
  key: KeyOf<C>,
  options: RefOptions<C> = { resume: Option.none() },
) {
  const transport = yield* ActorTransport;
  const cache = yield* Effect.serviceOption(QueryCache);
  const encodedKey = yield* Effect.orDie(Schema.encodeEffect(contract.key)(key));
  const address: Address = { contract: contract.name, version: contract.version, key: encodedKey };
  const encodeMessage = Schema.encodeEffect(contract.message);

  const initial = yield* fetchInitial(contract, address, options);
  const applied = yield* SubscriptionRef.make(initial);
  const observe = (next: Committed<SnapshotOf<C>>) =>
    SubscriptionRef.update(applied, (current) => newest(current, next));

  yield* Effect.forkScoped(
    Stream.runForEach(transport.changes(address, initial.revision), (projection) =>
      Effect.flatMap(decodeProjection(contract, projection), observe),
    ),
  );

  /**
   * The caller's active query keys, read from the cache at command time.
   * A client with no cache declares none and the reply refreshes nothing:
   * the single-flight field is additive, never required.
   */
  const declareActive: Effect.Effect<ReadonlyArray<QueryKey>> = Option.match(cache, {
    onNone: () => Effect.succeed<ReadonlyArray<QueryKey>>([]),
    onSome: (service) => service.active,
  });

  /**
   * The cache owns each unresolved command's dependents: they show stale
   * from before the first request until the command settles or this
   * reference closes, so the view shows stale content instead of a gap. An
   * Applied settlement delivers its captured refreshes first. A client with
   * no cache owns nothing.
   */
  const own = (active: ReadonlyArray<QueryKey>) =>
    Option.match(cache, {
      onNone: () => Commands.ownNothing<SnapshotOf<C>>(active),
      onSome: (service) =>
        Effect.map(
          service.claim(contract.name),
          (claim): Commands.SettlementHook<SnapshotOf<C>> =>
            (settlement) =>
              claim.settle(settlement.refreshed),
        ),
    });

  const adapter = remoteCommands(transport, address, (projection) =>
    decodeProjection(contract, projection),
  );
  const owner = yield* Commands.make<SnapshotOf<C>, RemoteRejection>({
    ...adapter,
    own,
    call: (commandId, payload, deadline, active) =>
      adapter
        .call(commandId, payload, deadline, active)
        .pipe(Effect.tap((settlement) => observe(settlement.committed))),
  });

  const submit = (message: MessageOf<C>, identified: Commands.Identified) =>
    owner.submit(identified, Effect.orDie(encodeMessage(message)), declareActive);

  const send = Effect.fn("Actor.ref.send")(function* (
    message: MessageOf<C>,
    sendOptions: DurableSendOptions | void,
  ) {
    const identified = yield* Commands.identify(suppliedId(sendOptions));
    const owned = yield* submit(message, identified);
    return identifiedHandle(owned) satisfies IdentifiedCommandHandle<SnapshotOf<C>, "remote">;
  });

  const call = Effect.fn("Actor.ref.call")(function* (
    message: MessageOf<C>,
    callOptions: DurableCallOptions,
  ) {
    const identified = yield* Commands.identify(suppliedId(callOptions));
    return yield* callThrough(
      submit(message, identified),
      identified.commandId,
      callOptions.timeout,
      owner.closed,
    );
  });

  const appliedSource = select(fromSubscriptionRef(applied), toApplied);
  const reference: RemoteActorRef<C> = {
    kind: "remote",
    applied: appliedSource,
    state: select(appliedSource, (committed) => committed.state),
    send,
    call,
  };
  return reference;
});
