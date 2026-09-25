import { Effect, Option, Schema, Stream, SubscriptionRef } from "effect";
import { refusalOf } from "./behavior-rules.js";
import type { Behavior } from "./behavior.js";
import { callThrough, identifiedHandle, suppliedId, toApplied } from "./command-handle.js";
import { isMinted } from "./command-id.js";
import * as Commands from "./command-owner.js";
import type { Committed } from "./engine-types.js";
import { transportCommands } from "./remote-commands.js";
import type { RemoteRejection } from "./remote-commands.js";
import type { Address, AnyContract, KeyOf, MessageOf, SnapshotOf } from "./contract.js";
import type { QueryKey } from "./query.js";
import { QueryCache, internalsOf } from "./query-client.js";
import type { QueryCacheService } from "./query-client.js";
import * as Provisional from "./provisional.js";
import { fromSubscriptionRef, select } from "./source.js";
import type { Source } from "./source.js";
import type { Projection, TransportReadError } from "./transport.js";
import { ActorTransport } from "./transport.js";
import type {
  ActorRef,
  Applied,
  DurableCallOptions,
  DurableSendOptions,
  CommandId,
  Displayed,
  IdentifiedCommandHandle,
  Refused,
} from "./vocabulary.js";

/**
 * A reference to an actor a host serves. It carries its address: the
 * contract and the key it was opened for. A form or a generated send reads
 * the address from the reference, so the plain post and the scripted send
 * can never name two different actors.
 */
export type RemoteActorRef<C extends AnyContract> = ActorRef<
  SnapshotOf<C>,
  MessageOf<C>,
  "remote"
> & {
  readonly contract: C;
  readonly key: KeyOf<C>;
};

/**
 * The command half of a remote reference: `send` and `call`, the address,
 * and no state. A full `RemoteActorRef` is one too.
 */
export interface RemoteCommandRef<C extends AnyContract> {
  readonly kind: "remote";
  readonly contract: C;
  readonly key: KeyOf<C>;
  readonly send: RemoteActorRef<C>["send"];
  readonly call: RemoteActorRef<C>["call"];
}

export interface RefOptions<C extends AnyContract> {
  /**
   * A snapshot the client already holds, for example one rendered into the
   * page by the server. The reference starts from it and subscribes to the
   * revisions after it. `None` fetches the latest snapshot first.
   */
  readonly resume: Option.Option<Applied<SnapshotOf<C>>>;
  /**
   * The actor's behavior, when the client can import it. A behavior with
   * `predict` makes the reference optimistic: a send with a fresh command ID
   * shows its predicted state at once, as a provisional revision, until the
   * committed base holds it or it is rejected. A supplied ID never predicts;
   * it waits for its receipt. A machine behavior never predicts. A message
   * the behavior refuses is never predicted: the host refuses it too.
   */
  readonly behavior?: Behavior<SnapshotOf<C>, MessageOf<C>, unknown, Refused>;
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

/** What the command surface needs from the reference that owns it. */
interface SurfaceHooks<C extends AnyContract> {
  /** A committed revision a settlement carried. */
  readonly observe: (next: Committed<SnapshotOf<C>>) => Effect.Effect<void>;
  /** The predicting display, when there is one. */
  readonly display: Option.Option<Provisional.Display<SnapshotOf<C>, MessageOf<C>>>;
  /** Whether the behavior refuses the message, so it is never predicted. */
  readonly refuses: (message: MessageOf<C>) => boolean;
}

/**
 * An `Unauthorized` tells the cache the principal may be gone, and
 * every query value this client read under it goes.
 */
const principalMayBeGone =
  (cache: Option.Option<QueryCacheService>) =>
  (error: { readonly _tag: string }): Effect.Effect<void> => {
    if (error._tag === "Unauthorized") {
      return Option.match(cache, {
        onNone: () => Effect.void,
        onSome: (service) => service.principalChanged,
      });
    }
    return Effect.void;
  };

/**
 * The commands of one remote address: one private owner in this scope,
 * `send` and `call`. A reference and a command reference share it; only a
 * reference has a snapshot to observe and a display to predict into.
 */
const commandSurface = Effect.fn("Actor.commandSurface")(function* <C extends AnyContract>(
  contract: C,
  address: Address,
  hooks: SurfaceHooks<C>,
) {
  const transport = yield* ActorTransport;
  const cache = yield* Effect.serviceOption(QueryCache);
  const encodeMessage = Schema.encodeEffect(contract.message);
  const { observe, display, refuses } = hooks;
  const withDisplay = (
    use: (found: Provisional.Display<SnapshotOf<C>, MessageOf<C>>) => Effect.Effect<void>,
  ): Effect.Effect<void> => Option.match(display, { onNone: () => Effect.void, onSome: use });
  // Every `Unauthorized` this reference receives tells the cache that the
  // principal may be gone, and every query value this client read
  // under it goes. The snapshot above was authorized, so a change stream
  // that ends with `Unauthorized` means the principal changed under it. A
  // refused send or call cannot tell a changed principal from one that may
  // read but not send, so it also costs one fresh read of each live entry.
  // It never loops: nothing reads again on its own after a refused command.
  const refused = principalMayBeGone(cache);
  const refusedPass = (failure: Commands.PassFailure<RemoteRejection>): Effect.Effect<void> => {
    if (failure._tag === "Refused") {
      return refused(failure.reason);
    }
    return Effect.void;
  };
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
   * Applied settlement delivers its captured refreshes first. A cache not
   * built by `QueryCache.layer` (a user's own, or a wrapper) keeps the public
   * contract instead: the contract is invalidated when the command starts and
   * the reply's refreshes are applied. A client with no cache owns nothing.
   */
  const own = (active: ReadonlyArray<QueryKey>) =>
    Option.match(cache, {
      onNone: () => Commands.ownNothing<SnapshotOf<C>>(active),
      onSome: (service) =>
        Option.match(internalsOf(service), {
          onNone: () =>
            Effect.as(
              service.invalidate(contract.name),
              (settlement: Commands.Settlement<SnapshotOf<C>>) =>
                service.apply(settlement.refreshed),
            ),
          onSome: (owning) =>
            Effect.map(
              owning.claim(contract.name),
              (claim): Commands.SettlementHook<SnapshotOf<C>> =>
                (settlement) =>
                  claim.settle(settlement.refreshed),
            ),
        }),
    });

  const adapter = transportCommands(transport, address, (projection) =>
    decodeProjection(contract, projection),
  );
  // The admission position each live record's last send reported. A receipt
  // pairs it with the committed revision to order other admissions.
  const admissions = new Map<CommandId, number>();
  const owner = yield* Commands.make<SnapshotOf<C>, RemoteRejection>({
    ...adapter,
    own,
    send: (commandId, payload) =>
      adapter.send(commandId, payload).pipe(
        Effect.tapError(refusedPass),
        Effect.tap((admission) =>
          Effect.andThen(
            Effect.sync(() => admissions.set(commandId, admission.admitted)),
            withDisplay((found) => found.admit(commandId, admission.admitted)),
          ),
        ),
      ),
    call: (commandId, payload, deadline, active) =>
      adapter.call(commandId, payload, deadline, active).pipe(
        Effect.tapError(refusedPass),
        Effect.tap((settlement) =>
          Effect.andThen(
            withDisplay((found) =>
              found.receipt(
                commandId,
                Option.fromNullishOr(admissions.get(commandId)),
                settlement.committed,
              ),
            ),
            observe(settlement.committed),
          ),
        ),
      ),
  });

  /**
   * One new record's own state. Its admission leaves with it. A fresh ID on
   * a predicting reference also shows its prediction until then: a rejected
   * record removes it, and an applied one leaves it for the base to absorb.
   * A message the behavior refuses is not predicted: the host's answer is
   * `Rejected(Refused)`, so showing it would only flash a state never held.
   */
  const enlist = (identified: Commands.Identified, message: MessageOf<C>): Commands.Enlist =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => admissions.delete(identified.commandId)));
      if (identified.identity === "fresh" && Option.isSome(display) && !refuses(message)) {
        yield* display.value.predict(identified.commandId, message);
      }
    });

  const submit = (message: MessageOf<C>, identified: Commands.Identified) =>
    owner.submit(
      identified,
      Effect.orDie(encodeMessage(message)),
      declareActive,
      enlist(identified, message),
    );

  const send = Effect.fn("Actor.remote.send")(function* (
    message: MessageOf<C>,
    sendOptions: DurableSendOptions | void,
  ) {
    const identified = yield* Commands.identify(suppliedId(sendOptions), isMinted(sendOptions));
    const owned = yield* submit(message, identified);
    return identifiedHandle(owned) satisfies IdentifiedCommandHandle<SnapshotOf<C>, "remote">;
  });

  const call = Effect.fn("Actor.remote.call")(function* (
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

  return { send, call };
});

/**
 * A reference that only sends. It reads no snapshot and follows no change
 * stream: a page that commands an actor it does not show holds one of these,
 * so the page's only live streams are the actors it draws. Commands go
 * through the same owner a full reference uses: the same identities,
 * retries, receipts, and single-flight refreshes of the page's active
 * queries. It never predicts; there is no state to predict into.
 */
export const remoteCommands = Effect.fn("Actor.remoteCommands")(function* <C extends AnyContract>(
  contract: C,
  key: KeyOf<C>,
) {
  const encodedKey = yield* Effect.orDie(Schema.encodeEffect(contract.key)(key));
  const address: Address = { contract: contract.name, version: contract.version, key: encodedKey };
  const surface = yield* commandSurface(contract, address, {
    observe: () => Effect.void,
    display: Option.none(),
    refuses: () => false,
  });
  const commands: RemoteCommandRef<C> = { kind: "remote", contract, key, ...surface };
  return commands;
});

/**
 * A client-side reference to an actor hosted elsewhere. The client holds the
 * contract, the key, and a transport, and the behavior only when it is given
 * one to predict with. `applied` is the latest committed snapshot the
 * transport delivered, so a later reference can resume without a gap.
 * `displayed` and `state` are what the reference shows: the committed base,
 * with this client's predicted commands applied over it (see `RefOptions`).
 *
 * Commands go through one private owner in this scope. `send` returns an
 * identified handle at once; the owner runs one send and one same-ID call per
 * pass, retries a lost pass within its bound, and keeps the exact bytes
 * while the command is unresolved.
 */
export const remote = Effect.fn("Actor.remote")(function* <C extends AnyContract>(
  contract: C,
  key: KeyOf<C>,
  options: RefOptions<C> = { resume: Option.none() },
) {
  const transport = yield* ActorTransport;
  const cache = yield* Effect.serviceOption(QueryCache);
  const encodedKey = yield* Effect.orDie(Schema.encodeEffect(contract.key)(key));
  const address: Address = { contract: contract.name, version: contract.version, key: encodedKey };

  const initial = yield* fetchInitial(contract, address, options);
  const applied = yield* SubscriptionRef.make(initial);
  const predict = Option.flatMap(Option.fromNullishOr(options.behavior), (behavior) =>
    Option.fromNullishOr(behavior.predict),
  );
  const refuses = (message: MessageOf<C>): boolean =>
    Option.isSome(
      Option.flatMap(Option.fromNullishOr(options.behavior), (behavior) =>
        refusalOf(behavior, message),
      ),
    );
  // Only a predicting reference keeps a display. Without one, `displayed`
  // and `state` derive from `applied`, so the three never disagree.
  const display = yield* Effect.transposeOption(
    Option.map(predict, (fn) => Provisional.make<SnapshotOf<C>, MessageOf<C>>(initial, fn)),
  );
  const withDisplay = (
    use: (found: Provisional.Display<SnapshotOf<C>, MessageOf<C>>) => Effect.Effect<void>,
  ): Effect.Effect<void> => Option.match(display, { onNone: () => Effect.void, onSome: use });
  const observe = (next: Committed<SnapshotOf<C>>) =>
    Effect.andThen(
      SubscriptionRef.update(applied, (current) => newest(current, next)),
      withDisplay((found) => found.offer(next)),
    );

  yield* Effect.forkScoped(
    Stream.runForEach(transport.changes(address, initial.revision), (projection) =>
      Effect.flatMap(decodeProjection(contract, projection), observe),
    ).pipe(Effect.tapError(principalMayBeGone(cache))),
  );

  const { send, call } = yield* commandSurface(contract, address, { observe, display, refuses });

  const appliedSource = select(fromSubscriptionRef(applied), toApplied);
  const displayed: Source<Displayed<SnapshotOf<C>>> = Option.match(display, {
    onNone: () => appliedSource,
    onSome: (found) => found.displayed,
  });
  const reference: RemoteActorRef<C> = {
    kind: "remote",
    contract,
    key,
    applied: appliedSource,
    displayed,
    state: select(displayed, (shown) => shown.state),
    send,
    call,
  };
  return reference;
});
