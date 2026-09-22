import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Schedule,
  Scheduler,
  Scope,
  SubscriptionRef,
} from "effect";
import * as Inspection from "../inspection.js";
import { freshCommandId } from "./command-id.js";
import type { Committed } from "./engine-types.js";
import type { QueryKey } from "./query.js";
import type { Source } from "./source.js";
import { fromSubscriptionRef } from "./source.js";
import type { Refreshed } from "./transport.js";
import type { CommandId } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The bounded automatic work for one command sequence. The pass deadline is
 * one finite client deadline around a whole pass (one send and one same-ID
 * call). It is separate from a caller's wait timeout and from the delay.
 */
export interface CommandPolicySettings {
  /** Automatic passes in one sequence, including the first pass. */
  readonly passes: number;
  readonly passDeadline: Duration.Input;
  /** The first retry delay. Later delays grow exponentially with jitter. */
  readonly baseDelay: Duration.Input;
  /** The largest delay between passes, applied after jitter. */
  readonly maxDelay: Duration.Input;
}

/** Source-private: the production policy. Tests may shorten it. */
export const CommandPolicy = Context.Reference<CommandPolicySettings>(
  "effect-frame/src/actor/command-owner/CommandPolicy",
  {
    defaultValue: () => ({
      passes: 8,
      passDeadline: "10 seconds",
      baseDelay: "200 millis",
      maxDelay: "10 seconds",
    }),
  },
);

/**
 * `upTo({ times })` counts recurrences after the first pass, so eight passes
 * are seven recurrences. The cap is applied after jitter, so no delay exceeds
 * the maximum.
 */
export const retrySchedule = (policy: CommandPolicySettings) => {
  const maxDelay = Duration.fromInputUnsafe(policy.maxDelay);
  return Schedule.exponential(policy.baseDelay).pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, maxDelay))),
    Schedule.upTo({ times: policy.passes - 1 }),
  );
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** How the command ID was obtained. A supplied ID never becomes fresh. */
export type Identity = "fresh" | "supplied";

/** One command ID with its provenance. Only `identify` creates a fresh one. */
export interface Identified {
  readonly commandId: CommandId;
  readonly identity: Identity;
}

/**
 * Omitted means the framework mints a secure fresh ID. Supplied means
 * supplied, whatever the string looks like: provenance is never inferred
 * from the ID itself.
 */
export const identify = (supplied: Option.Option<CommandId>): Effect.Effect<Identified> =>
  Option.match(supplied, {
    onNone: () =>
      Effect.map(freshCommandId, (commandId): Identified => ({ commandId, identity: "fresh" })),
    onSome: (commandId) => Effect.succeed<Identified>({ commandId, identity: "supplied" }),
  });

/** The owner's numeric lifecycle. Public adapters project it. */
export type Lifecycle<State, Rejection> =
  | { readonly _tag: "Sent" }
  | { readonly _tag: "Admitted"; readonly admitted: number }
  | {
      readonly _tag: "Applied";
      readonly admitted: number;
      readonly committed: Committed<State>;
    }
  | { readonly _tag: "Rejected"; readonly reason: Rejection }
  | {
      readonly _tag: "Uncertain";
      readonly attempt: number;
      readonly admitted: Option.Option<number>;
    };

export type Terminal<State, Rejection> = Extract<
  Lifecycle<State, Rejection>,
  { readonly _tag: "Applied" | "Rejected" }
>;

// ---------------------------------------------------------------------------
// Adapter protocol
// ---------------------------------------------------------------------------

/**
 * How one request of a pass ended without a result. `Lost` is uncertainty
 * evidence: the request may have reached admission. `Refused` carries a typed
 * refusal from the actor or its transport.
 */
export type PassFailure<Rejection> =
  | { readonly _tag: "Lost" }
  | { readonly _tag: "Refused"; readonly reason: Rejection };

export const lost: PassFailure<never> = { _tag: "Lost" };

export const refused = <Rejection>(reason: Rejection): PassFailure<Rejection> => ({
  _tag: "Refused",
  reason,
});

export interface Settlement<State> {
  readonly committed: Committed<State>;
  /** Query refreshes the settlement call earned. Empty on a durable engine. */
  readonly refreshed: ReadonlyArray<Refreshed>;
}

/**
 * One placement's admission and exact-result requests. The owner runs every
 * pass through these two functions with the retained ID and exact bytes.
 */
/** What a record's owner does with its exact settlement before it releases. */
export type SettlementHook<State> = (settlement: Settlement<State>) => Effect.Effect<void>;

export interface CommandAdapter<State, Rejection> {
  /** The placement, as inspection reports it. */
  readonly kind: "durable" | "remote";
  /**
   * Runs once per record, before its first pass, inside the record scope.
   * Anything it registers is released when the record leaves: on terminal
   * settlement or when the owner closes. Uncertain keeps it. The returned
   * hook receives an Applied settlement before that release.
   */
  readonly own: (
    active: ReadonlyArray<QueryKey>,
  ) => Effect.Effect<SettlementHook<State>, never, Scope.Scope>;
  /** True when the physical actor behind this adapter can admit nothing more. */
  readonly closed: Effect.Effect<boolean>;
  /** One admission request. No active query keys travel with it. */
  readonly send: (
    commandId: CommandId,
    payload: string,
  ) => Effect.Effect<{ readonly admitted: number }, PassFailure<Rejection>>;
  /** One same-ID request for the exact stored result. */
  readonly call: (
    commandId: CommandId,
    payload: string,
    deadline: Duration.Duration,
    active: ReadonlyArray<QueryKey>,
  ) => Effect.Effect<Settlement<State>, PassFailure<Rejection>>;
  /** The refusal a stopped owner or actor gives a new submission. */
  readonly stopped: () => Rejection;
  /** The refusal for different bytes under a live command ID. */
  readonly conflict: (commandId: CommandId) => Rejection;
}

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

/** One command as its caller holds it. The view outlives record collection. */
export interface OwnedCommand<State, Rejection> {
  readonly commandId: CommandId;
  readonly identity: Identity;
  readonly lifecycle: Source<Lifecycle<State, Rejection>>;
  readonly settled: Effect.Effect<Terminal<State, Rejection>>;
  readonly retry: Effect.Effect<void>;
}

/** One retained record as a sample reads it. Payload bytes stay private. */
export interface RetainedCommand<State, Rejection> {
  readonly commandId: CommandId;
  readonly identity: Identity;
  readonly attempt: number;
  readonly running: boolean;
  readonly possibleAdmission: boolean;
  readonly lifecycle: Lifecycle<State, Rejection>;
}

export interface CommandOwner<State, Rejection> {
  /**
   * Make or join one command. `prepare` encodes the message; it runs once,
   * after the closed check, and never again for this command.
   */
  readonly submit: (
    identified: Identified,
    prepare: Effect.Effect<string>,
    active: Effect.Effect<ReadonlyArray<QueryKey>>,
  ) => Effect.Effect<OwnedCommand<State, Rejection>>;
  /** Completes when the owner scope begins to close. */
  readonly closed: Effect.Effect<void>;
  /** The live records. A command leaves when it is terminal. */
  readonly retained: Effect.Effect<ReadonlyArray<RetainedCommand<State, Rejection>>>;
  /** Test receipt: the retained exact bytes of one live command. */
  readonly payloadOf: (commandId: CommandId) => Option.Option<string>;
}

interface CommandRecord<State, Rejection> {
  readonly commandId: CommandId;
  readonly identity: Identity;
  readonly payload: string;
  readonly active: ReadonlyArray<QueryKey>;
  readonly state: SubscriptionRef.SubscriptionRef<Lifecycle<State, Rejection>>;
  readonly terminal: Deferred.Deferred<Terminal<State, Rejection>>;
  /** Owns the record's workers and registrations. Closed when the record leaves. */
  readonly scope: Scope.Closeable;
  /** Set once the adapter owns the record. No sequence starts before that. */
  settle: Option.Option<SettlementHook<State>>;
  possibleAdmission: boolean;
  admitted: Option.Option<number>;
  attempt: number;
  running: boolean;
  done: boolean;
}

const isOpen = Predicate.or(
  Predicate.or(Predicate.isTagged("Sent"), Predicate.isTagged("Admitted")),
  Predicate.isTagged("Uncertain"),
);

/** Nothing to own and nothing to do at settlement. */
export const ownNothing = <State>(
  _active: ReadonlyArray<QueryKey>,
): Effect.Effect<SettlementHook<State>> => Effect.succeed(() => Effect.void);

interface Inspected {
  readonly registry: Inspection.RegistryService;
  readonly owner: Inspection.OwnerToken;
}

/** How one pass ended when it did not produce a settlement. */
type PassOutcome<Rejection> =
  | { readonly _tag: "Lost" }
  | { readonly _tag: "Hold" }
  | { readonly _tag: "Reject"; readonly reason: Rejection };

const isLost = <Rejection>(outcome: PassOutcome<Rejection>): boolean => outcome._tag === "Lost";

/** Where one submission landed in the owner's live records. */
type Placement<State, Rejection> =
  | {
      readonly _tag: "Live";
      readonly record: CommandRecord<State, Rejection>;
      readonly created: boolean;
    }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Stopped" };

const view = <State, Rejection>(
  commandId: CommandId,
  identity: Identity,
  state: SubscriptionRef.SubscriptionRef<Lifecycle<State, Rejection>>,
  terminal: Deferred.Deferred<Terminal<State, Rejection>>,
  retry: Effect.Effect<void>,
): OwnedCommand<State, Rejection> => ({
  commandId,
  identity,
  lifecycle: fromSubscriptionRef(state),
  settled: Deferred.await(terminal),
  retry,
});

/**
 * The private command owner shared by durable and remote references.
 *
 * It owns the retained records, their exact bytes, the bounded retry
 * sequences, and each sequence's child scope. It runs every worker with the
 * context and Scheduler captured when the reference was built, so a short
 * event fiber or call waiter never owns command work. Closing the owner scope
 * stops workers; it does not cancel admitted durable work.
 */
export const make = Effect.fn("Actor.commands.make")(function* <
  State,
  Rejection extends { readonly _tag: string },
>(adapter: CommandAdapter<State, Rejection>) {
  const ownerScope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  const scheduler = yield* Scheduler.Scheduler;
  const policy = yield* CommandPolicy;
  const passDeadline = Duration.fromInputUnsafe(policy.passDeadline);
  const schedule = retrySchedule(policy);
  const records = new Map<CommandId, CommandRecord<State, Rejection>>();
  const closedSignal = yield* Deferred.make<void>();
  // Inspection is the root's optional registry. A sample reads the retained
  // records themselves; no second command store exists for it.
  const registry = yield* Effect.serviceOption(Inspection.Registry);
  const inspection = yield* Option.match(registry, {
    onNone: () => Effect.succeed(Option.none<Inspected>()),
    onSome: (found) =>
      Effect.map(Inspection.ownerFor(found), (owner) => Option.some({ registry: found, owner })),
  });

  // The owner scope reads Closed from the first moment of its close, before
  // any finalizer runs, so this check refuses work during shutdown too.
  const closing = () => ownerScope.state._tag === "Closed";

  yield* Effect.addFinalizer(() =>
    Effect.andThen(
      Deferred.succeed(closedSignal, void 0),
      Effect.sync(() => records.clear()),
    ),
  );

  /** Runs detached from the caller: construction context and Scheduler. */
  const owned = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideContext(context),
      Effect.provideService(Scheduler.Scheduler, scheduler),
    );

  const publish = (record: CommandRecord<State, Rejection>, next: Lifecycle<State, Rejection>) =>
    Effect.suspend(() => {
      if (record.done) {
        return Effect.void;
      }
      return SubscriptionRef.set(record.state, next);
    });

  const uncertain = (record: CommandRecord<State, Rejection>): Lifecycle<State, Rejection> => ({
    _tag: "Uncertain",
    attempt: record.attempt,
    admitted: record.admitted,
  });

  /** Terminal settlement. The record leaves the owner; its handle keeps the value. */
  const finish = (record: CommandRecord<State, Rejection>, terminal: Terminal<State, Rejection>) =>
    Effect.suspend(() => {
      if (record.done) {
        return Effect.void;
      }
      record.done = true;
      if (records.get(record.commandId) === record) {
        records.delete(record.commandId);
      }
      // Release the record's scope, and with it the cache ownership and the
      // inspection registration, before any reader can see the terminal
      // state or a waiter can observe settlement.
      return Scope.close(record.scope, Exit.void).pipe(
        Effect.andThen(SubscriptionRef.set(record.state, terminal)),
        Effect.andThen(Deferred.succeed(record.terminal, terminal)),
      );
    });

  /**
   * Classifies one failed request. A conflict is always conclusive for these
   * bytes. Any other refusal is conclusive only while no earlier request of
   * this ID may have reached admission. A stopped actor after a possible
   * admission is uncertainty: its pending row can still commit elsewhere.
   */
  const classify = (
    record: CommandRecord<State, Rejection>,
    failure: PassFailure<Rejection>,
  ): PassOutcome<Rejection> => {
    if (failure._tag === "Lost") {
      record.possibleAdmission = true;
      return { _tag: "Lost" };
    }
    if (failure.reason._tag === "CommandConflict" || !record.possibleAdmission) {
      return { _tag: "Reject", reason: failure.reason };
    }
    if (failure.reason._tag === "ActorStopped") {
      return { _tag: "Lost" };
    }
    return { _tag: "Hold" };
  };

  const pass = (record: CommandRecord<State, Rejection>) =>
    Effect.gen(function* () {
      record.attempt += 1;
      const requests = Effect.gen(function* () {
        const admission = yield* Effect.mapError(
          adapter.send(record.commandId, record.payload),
          (failure) => classify(record, failure),
        );
        record.possibleAdmission = true;
        record.admitted = Option.some(admission.admitted);
        yield* publish(record, { _tag: "Admitted", admitted: admission.admitted });
        return yield* Effect.mapError(
          adapter.call(record.commandId, record.payload, passDeadline, record.active),
          (failure) => classify(record, failure),
        );
      });
      const settled = yield* Effect.timeoutOption(requests, passDeadline);
      if (Option.isNone(settled)) {
        record.possibleAdmission = true;
        return yield* Effect.fail<PassOutcome<Rejection>>({ _tag: "Lost" });
      }
      return settled.value;
    }).pipe(
      Effect.tapError((outcome) => {
        // A lost pass that the schedule will follow shows Uncertain now. The
        // pass that ends the sequence is published by the sequence itself,
        // after the record is idle, so a retry that sees it can start.
        if (outcome._tag === "Lost" && record.attempt < policy.passes) {
          return publish(record, uncertain(record));
        }
        return Effect.void;
      }),
    );

  const sequence = (record: CommandRecord<State, Rejection>) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(Effect.retry(pass(record), { schedule, while: isLost }));
      if (Exit.isSuccess(outcome)) {
        const admitted = Option.getOrElse(record.admitted, () => 0);
        if (Option.isSome(record.settle)) {
          yield* record.settle.value(outcome.value);
        }
        yield* finish(record, {
          _tag: "Applied",
          admitted,
          committed: outcome.value.committed,
        });
        return;
      }
      const failure = Exit.findErrorOption(outcome);
      if (Option.isNone(failure)) {
        return;
      }
      if (failure.value._tag === "Reject") {
        yield* finish(record, { _tag: "Rejected", reason: failure.value.reason });
        return;
      }
      // Exhausted or held: the record stays retained and Uncertain, and is
      // idle before anyone can see that state.
      record.running = false;
      yield* publish(record, uncertain(record));
    });

  const startSequence = (record: CommandRecord<State, Rejection>): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (record.done || record.running || Option.isNone(record.settle) || closing()) {
        return Effect.void;
      }
      record.running = true;
      record.attempt = 0;
      const worker = Scope.forkUnsafe(record.scope);
      const body = Effect.ensuring(
        sequence(record),
        Effect.suspend(() => {
          record.running = false;
          return Scope.close(worker, Exit.void);
        }),
      );
      return Effect.asVoid(Effect.forkIn(owned(body), worker));
    });

  const inspectionLifecycle = (
    record: CommandRecord<State, Rejection>,
    lifecycle: Lifecycle<State, Rejection>,
  ): Inspection.CommandLifecycle => {
    if (isOpen(lifecycle)) {
      return lifecycle;
    }
    // A terminal record has left before its state turns terminal, so a
    // sample never reads this. Report the last open fact the record holds.
    return Option.match(record.admitted, {
      onNone: (): Inspection.CommandLifecycle => ({ _tag: "Sent" }),
      onSome: (admitted): Inspection.CommandLifecycle => ({ _tag: "Admitted", admitted }),
    });
  };

  /**
   * The adapter takes ownership, and inspection registers the record, in the
   * record scope. Both are released when the record leaves.
   */
  const adopt = (record: CommandRecord<State, Rejection>) =>
    Effect.gen(function* () {
      const hook = yield* Scope.provide(adapter.own(record.active), record.scope);
      record.settle = Option.some(hook);
      if (Option.isSome(inspection)) {
        const { registry: root, owner } = inspection.value;
        yield* Scope.provide(
          root.register(owner, (id) =>
            Effect.map(
              SubscriptionRef.get(record.state),
              (lifecycle): Inspection.CommandRecord => ({
                _tag: "Command",
                id,
                ownerId: owner.id,
                parentOwnerId: owner.parentId,
                kind: adapter.kind,
                commandId: record.commandId,
                identity: record.identity,
                attempt: record.attempt,
                running: record.running,
                lifecycle: inspectionLifecycle(record, lifecycle),
              }),
            ),
          ),
          record.scope,
        );
      }
    });

  const retryOf = (record: CommandRecord<State, Rejection>) =>
    Effect.suspend(() => startSequence(record));

  /** A command that never reached the owner's records. Its retry does nothing. */
  const detached = (
    commandId: CommandId,
    identity: Identity,
    lifecycle: Lifecycle<State, Rejection>,
    settled: Option.Option<Terminal<State, Rejection>>,
  ) =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make(lifecycle);
      const terminal = yield* Deferred.make<Terminal<State, Rejection>>();
      if (Option.isSome(settled)) {
        yield* Deferred.succeed(terminal, settled.value);
      }
      return view(commandId, identity, state, terminal, Effect.void);
    });

  const rejected = (commandId: CommandId, identity: Identity, reason: Rejection) => {
    const terminal: Terminal<State, Rejection> = { _tag: "Rejected", reason };
    return detached(commandId, identity, terminal, Option.some(terminal));
  };

  /**
   * A refused submission never left this client. A fresh ID is conclusive:
   * nothing else can hold it. A supplied ID may already be admitted elsewhere,
   * so the honest answer is Uncertain.
   */
  const stoppedBeforeWork = (commandId: CommandId, identity: Identity) => {
    if (identity === "fresh") {
      return rejected(commandId, identity, adapter.stopped());
    }
    return detached(
      commandId,
      identity,
      { _tag: "Uncertain", attempt: 0, admitted: Option.none() },
      Option.none(),
    );
  };

  const isStopped = Effect.map(adapter.closed, (actorClosed) => actorClosed || closing());

  const submit = Effect.fn("Actor.commands.submit")(function* (
    identified: Identified,
    prepare: Effect.Effect<string>,
    activeKeys: Effect.Effect<ReadonlyArray<QueryKey>>,
  ) {
    const { commandId, identity } = identified;
    if (yield* isStopped) {
      return yield* stoppedBeforeWork(commandId, identity);
    }
    const payload = yield* prepare;
    if (yield* isStopped) {
      return yield* stoppedBeforeWork(commandId, identity);
    }
    const active = yield* activeKeys;
    const state = yield* SubscriptionRef.make<Lifecycle<State, Rejection>>({ _tag: "Sent" });
    const terminal = yield* Deferred.make<Terminal<State, Rejection>>();
    // Join, refuse, or insert in one synchronous step, so two submissions of
    // one ID cannot both create a record.
    const placed = yield* Effect.sync((): Placement<State, Rejection> => {
      const existing = Option.fromNullishOr(records.get(commandId));
      if (Option.isSome(existing)) {
        if (existing.value.payload === payload) {
          return { _tag: "Live", record: existing.value, created: false };
        }
        return { _tag: "Conflict" };
      }
      if (closing()) {
        return { _tag: "Stopped" };
      }
      const record: CommandRecord<State, Rejection> = {
        commandId,
        identity,
        payload,
        active,
        state,
        terminal,
        scope: Scope.forkUnsafe(ownerScope),
        settle: Option.none(),
        possibleAdmission: identity === "supplied",
        admitted: Option.none(),
        attempt: 0,
        running: false,
        done: false,
      };
      records.set(commandId, record);
      return { _tag: "Live", record, created: true };
    });
    if (placed._tag === "Stopped") {
      return yield* stoppedBeforeWork(commandId, identity);
    }
    if (placed._tag === "Conflict") {
      return yield* rejected(commandId, identity, adapter.conflict(commandId));
    }
    const record = placed.record;
    if (placed.created) {
      yield* adopt(record);
    }
    // A new record starts its first sequence. Resubmitting the same bytes to
    // a retained, idle record is a retry: it starts one new bounded sequence.
    yield* startSequence(record);
    return view(record.commandId, record.identity, record.state, record.terminal, retryOf(record));
  });

  const retained = Effect.suspend(() =>
    Effect.forEach(Array.from(records.values()), (record) =>
      Effect.map(
        SubscriptionRef.get(record.state),
        (lifecycle): RetainedCommand<State, Rejection> => ({
          commandId: record.commandId,
          identity: record.identity,
          attempt: record.attempt,
          running: record.running,
          possibleAdmission: record.possibleAdmission,
          lifecycle,
        }),
      ),
    ),
  );

  return {
    submit,
    closed: Deferred.await(closedSignal),
    retained,
    payloadOf: (commandId) =>
      Option.map(Option.fromNullishOr(records.get(commandId)), (record) => record.payload),
  } satisfies CommandOwner<State, Rejection>;
});
