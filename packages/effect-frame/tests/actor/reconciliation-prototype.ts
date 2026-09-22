/* oxlint-disable effect/noNullish -- The prototype models unobserved evidence explicitly. */

/**
 * Private issue-67 prototype. This file is test evidence, not package API.
 *
 * The classifier treats a receipt as settlement evidence. A stream projection
 * supplies a committed public base only. It never supplies command identity.
 */

import { Crypto, Effect, Option, Ref, Result, Schema, Stream, SubscriptionRef } from "effect";
import type { Duration } from "effect";
import { CommandId } from "effect-frame/actor";
import type { Address, Projection, TransportService } from "effect-frame/actor/client";

export type Membership = "included" | "excluded" | "unknown";

export interface ReceiptAnchor {
  readonly commandId: string;
  readonly admitted: number;
  readonly revision: number;
}

export interface Candidate<State> {
  readonly revision: number;
  readonly state: State;
}

export interface PendingOverlay<State> {
  readonly commandId: string;
  /** Undefined means that the client has not observed admission yet. */
  readonly admitted: number | undefined;
  readonly predict: (state: State) => State;
}

export interface Reconciliation<State> {
  readonly base: Candidate<State>;
  readonly visible: State;
  readonly held: Candidate<State> | undefined;
}

export const exactMembership = (receiptRevision: number, candidateRevision: number): Membership => {
  if (receiptRevision <= candidateRevision) return "included";
  return "excluded";
};

/**
 * Classifies another admission using one exact receipt anchor.
 *
 * An anchor proves the prefix through its own admission when its revision is
 * in the candidate. If the anchor is newer than the candidate, it proves only
 * the suffix beginning at its own admission is absent. Earlier admissions are
 * unknown because the candidate may already include them.
 */
export const anchoredMembership = (
  anchor: Pick<ReceiptAnchor, "admitted" | "revision"> | undefined,
  candidateRevision: number,
  admission: number | undefined,
): Membership => {
  if (anchor === undefined || admission === undefined) return "unknown";
  if (anchor.revision > candidateRevision) {
    if (admission >= anchor.admitted) return "excluded";
    return "unknown";
  }
  if (admission <= anchor.admitted) return "included";
  if (anchor.revision === candidateRevision) return "excluded";
  return "unknown";
};

const membershipFor = <State>(
  pending: PendingOverlay<State>,
  candidateRevision: number,
  receipts: ReadonlyMap<string, ReceiptAnchor>,
  anchor: ReceiptAnchor | undefined,
): Membership => {
  const receipt = receipts.get(pending.commandId);
  if (receipt !== undefined) {
    return exactMembership(receipt.revision, candidateRevision);
  }
  return anchoredMembership(anchor, candidateRevision, pending.admitted);
};

interface ClassifiedCandidate<State> {
  readonly candidate: Candidate<State>;
  readonly visible: State;
  readonly classified: boolean;
}

const classifyCandidate = <State>(
  candidate: Candidate<State>,
  pending: ReadonlyArray<PendingOverlay<State>>,
  receipts: ReadonlyMap<string, ReceiptAnchor>,
  anchor: ReceiptAnchor | undefined,
): ClassifiedCandidate<State> => {
  let visible = candidate.state;
  for (const item of pending) {
    const membership = membershipFor(item, candidate.revision, receipts, anchor);
    if (membership === "unknown") {
      return { candidate, visible, classified: false };
    }
    if (membership === "excluded") {
      visible = item.predict(visible);
    }
  }
  return { candidate, visible, classified: true };
};

const greatest = <State>(
  left: Candidate<State> | undefined,
  right: Candidate<State> | undefined,
): Candidate<State> | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (right.revision >= left.revision) return right;
  return left;
};

/**
 * Publishes the newest classified candidate. Unknown membership keeps the
 * prior coherent view and retains one greatest conflated candidate. A safe
 * older candidate can advance the base while the newer candidate remains held.
 */
export const reconcile = <State>(
  previous: Reconciliation<State>,
  candidate: Candidate<State>,
  pending: ReadonlyArray<PendingOverlay<State>>,
  receipts: ReadonlyMap<string, ReceiptAnchor>,
  anchor: ReceiptAnchor | undefined,
): Reconciliation<State> => {
  const newestHeld = greatest(previous.held, candidate);
  const classifiedCandidate = classifyCandidate(candidate, pending, receipts, anchor);
  let classifiedPreviousHeld: ClassifiedCandidate<State> | undefined;
  if (previous.held !== undefined) {
    classifiedPreviousHeld = classifyCandidate(previous.held, pending, receipts, anchor);
  }

  let base = previous.base;
  let visible = previous.visible;
  let held: Candidate<State> | undefined = newestHeld;

  if (classifiedCandidate.classified && candidate.revision >= base.revision) {
    base = candidate;
    visible = classifiedCandidate.visible;
  }
  if (
    classifiedPreviousHeld?.classified === true &&
    classifiedPreviousHeld.candidate.revision >= base.revision
  ) {
    base = classifiedPreviousHeld.candidate;
    visible = classifiedPreviousHeld.visible;
  }

  if (newestHeld !== undefined) {
    const classifiedNewestHeld = classifyCandidate(newestHeld, pending, receipts, anchor);
    if (classifiedNewestHeld.classified && newestHeld.revision <= base.revision) {
      held = undefined;
    }
  }

  return { base, visible, held };
};

export type CommandIdentity = "generated" | "supplied";
export type PredictionPolicy = "predict-immediately" | "await-receipt";

export const predictionPolicy = (identity: CommandIdentity): PredictionPolicy => {
  if (identity === "generated") return "predict-immediately";
  return "await-receipt";
};

export type RefusalAfterAdmission = "uncertain" | "rejected";

/** A later refusal cannot erase the possibility that an earlier request committed. */
export const classifyRefusalAfterPossibleAdmission = (
  possibleAdmission: boolean,
): RefusalAfterAdmission => {
  if (possibleAdmission) return "uncertain";
  return "rejected";
};

export type CommandPhase = "pending" | "applied" | "uncertain" | "rejected";

export interface ClientCommand<State> {
  readonly commandId: CommandId;
  readonly identity: CommandIdentity;
  readonly payload: string;
  readonly admitted: number | undefined;
  readonly attempts: number;
  readonly possibleAdmission: boolean;
  readonly phase: CommandPhase;
  readonly exact: Candidate<State> | undefined;
}

export interface CoordinatorWorkers {
  readonly activeStream: number;
  readonly activeCommands: number;
  readonly streamStarts: number;
  readonly streamStops: number;
  readonly commandStarts: number;
  readonly commandStops: number;
}

export interface ClientCoordinator<State, Message> {
  readonly view: Effect.Effect<Reconciliation<State>>;
  readonly changes: Stream.Stream<Reconciliation<State>>;
  readonly command: (commandId: CommandId) => Effect.Effect<Option.Option<ClientCommand<State>>>;
  readonly workers: Effect.Effect<CoordinatorWorkers>;
  readonly submitGenerated: (
    message: Message,
    predict: (state: State) => State,
  ) => Effect.Effect<ClientCommand<State>>;
  readonly submitSupplied: (
    commandId: CommandId,
    message: Message,
    predict: (state: State) => State,
  ) => Effect.Effect<ClientCommand<State>>;
  readonly retry: (commandId: CommandId) => Effect.Effect<void>;
}

export interface CoordinatorOptions<State, Message> {
  readonly transport: TransportService;
  readonly address: Address;
  readonly encode: (message: Message) => Effect.Effect<string>;
  readonly decode: (projection: Projection) => Effect.Effect<Candidate<State>>;
  readonly timeout: Duration.Input;
  readonly retryDelay: Duration.Input;
  readonly maxAttempts: number;
}

const decodeCommandId = Schema.decodeSync(CommandId);

interface StoredCommand<State> extends ClientCommand<State> {
  readonly predict: (state: State) => State;
  readonly running: boolean;
  readonly incorporated: boolean;
}

interface CoordinatorData<State> {
  readonly reconciliation: Reconciliation<State>;
  readonly commands: ReadonlyMap<CommandId, StoredCommand<State>>;
  readonly receipts: ReadonlyMap<string, ReceiptAnchor>;
  readonly anchor: ReceiptAnchor | undefined;
}

const publicCommand = <State>(command: StoredCommand<State>): ClientCommand<State> => ({
  commandId: command.commandId,
  identity: command.identity,
  payload: command.payload,
  admitted: command.admitted,
  attempts: command.attempts,
  possibleAdmission: command.possibleAdmission,
  phase: command.phase,
  exact: command.exact,
});

const newestAnchor = (receipts: ReadonlyMap<string, ReceiptAnchor>): ReceiptAnchor | undefined => {
  let newest: ReceiptAnchor | undefined;
  for (const receipt of receipts.values()) {
    if (newest === undefined || receipt.admitted > newest.admitted) newest = receipt;
  }
  return newest;
};

/**
 * A private scoped client coordinator. It owns stream reconciliation, command
 * retries, overlays, exact public results, and local worker lifetime. The
 * transport remains the real ActorHost transport supplied by the caller.
 */
export const makeCoordinator = Effect.fn("Reconciliation.makeCoordinator")(function* <
  State,
  Message,
>(options: CoordinatorOptions<State, Message>) {
  const ownerScope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const initial = yield* options.transport
    .snapshot(options.address)
    .pipe(Effect.flatMap(options.decode));
  const view = yield* SubscriptionRef.make<Reconciliation<State>>({
    base: initial,
    visible: initial.state,
    held: undefined,
  });
  const data = yield* Ref.make<CoordinatorData<State>>({
    reconciliation: { base: initial, visible: initial.state, held: undefined },
    commands: new Map(),
    receipts: new Map(),
    anchor: undefined,
  });
  const workers = yield* Ref.make<CoordinatorWorkers>({
    activeStream: 0,
    activeCommands: 0,
    streamStarts: 0,
    streamStops: 0,
    commandStarts: 0,
    commandStops: 0,
  });
  const setData = (next: CoordinatorData<State>) =>
    Effect.all([Ref.set(data, next), SubscriptionRef.set(view, next.reconciliation)]).pipe(
      Effect.asVoid,
    );

  const activeOverlays = (commands: ReadonlyMap<CommandId, StoredCommand<State>>) =>
    Array.from(commands.values())
      .filter((command) => command.phase !== "rejected" && !command.incorporated)
      .map((command): PendingOverlay<State> => ({
        commandId: command.commandId,
        admitted: command.admitted,
        predict: command.predict,
      }));

  const acceptCandidate = Effect.fn("Reconciliation.acceptCandidate")(function* (
    candidate: Candidate<State>,
  ) {
    const current = yield* Ref.get(data);
    const reconciled = reconcile(
      current.reconciliation,
      candidate,
      activeOverlays(current.commands),
      current.receipts,
      current.anchor,
    );
    const releasable = Array.from(current.commands.values()).filter(
      (command) =>
        command.exact !== undefined && command.exact.revision <= reconciled.base.revision,
    );
    if (releasable.length === 0) {
      yield* setData({ ...current, reconciliation: reconciled });
      return;
    }
    const commands = new Map(current.commands);
    for (const command of releasable) {
      commands.set(command.commandId, { ...command, incorporated: true });
    }
    const released = reconcile(
      reconciled,
      candidate,
      activeOverlays(commands),
      current.receipts,
      current.anchor,
    );
    yield* setData({ ...current, commands, reconciliation: released });
  });

  const updateCommand = Effect.fn("Reconciliation.updateCommand")(function* (
    commandId: CommandId,
    update: (command: StoredCommand<State>) => StoredCommand<State>,
    recomputeView: boolean = false,
  ) {
    const current = yield* Ref.get(data);
    const command = current.commands.get(commandId);
    if (command === undefined) return;
    const commands = new Map(current.commands);
    commands.set(commandId, update(command));
    let reconciliation = current.reconciliation;
    if (recomputeView) {
      reconciliation = reconcile(
        current.reconciliation,
        current.reconciliation.base,
        activeOverlays(commands),
        current.receipts,
        current.anchor,
      );
    }
    yield* setData({ ...current, commands, reconciliation });
  });

  const recordReceipt = Effect.fn("Reconciliation.recordReceipt")(function* (
    commandId: CommandId,
    admitted: number,
    revision: number,
  ) {
    const current = yield* Ref.get(data);
    const receipt: ReceiptAnchor = { commandId, admitted, revision };
    const receipts = new Map(current.receipts);
    receipts.set(commandId, receipt);
    yield* setData({ ...current, receipts, anchor: newestAnchor(receipts) });
  });

  const updateWorkers = (update: (current: CoordinatorWorkers) => CoordinatorWorkers) =>
    Ref.update(workers, update);

  const runAttempt = Effect.fn("Reconciliation.runAttempt")(function* (commandId: CommandId) {
    const current = yield* Ref.get(data);
    const command = current.commands.get(commandId);
    if (command === undefined) return false;
    const send = yield* Effect.result(
      options.transport.send(options.address, command.commandId, command.payload, []),
    );
    if (Result.isFailure(send)) {
      const possibleAdmission =
        command.possibleAdmission ||
        send.failure._tag === "Unreachable" ||
        send.failure._tag === "ActorStopped";
      const phase: CommandPhase = (() => {
        if (send.failure._tag === "CommandConflict") return "rejected";
        if (send.failure._tag === "Unauthorized") {
          return classifyRefusalAfterPossibleAdmission(possibleAdmission);
        }
        if (send.failure._tag === "ContractMismatch") {
          return classifyRefusalAfterPossibleAdmission(possibleAdmission);
        }
        if (send.failure._tag === "UnknownContract") {
          return classifyRefusalAfterPossibleAdmission(possibleAdmission);
        }
        return command.phase;
      })();
      yield* updateCommand(
        commandId,
        (latest) => ({
          ...latest,
          possibleAdmission,
          phase,
        }),
        phase === "rejected",
      );
      return false;
    }
    const receipt = send.success.receipt;
    yield* updateCommand(commandId, (latest) => ({
      ...latest,
      admitted: receipt.admitted,
      possibleAdmission: true,
    }));
    if (Option.isSome(receipt.committed)) {
      yield* recordReceipt(commandId, receipt.admitted, receipt.committed.value);
    }

    const call = yield* Effect.result(
      options.transport.call(options.address, commandId, command.payload, options.timeout, []),
    );
    if (Result.isFailure(call)) {
      yield* updateCommand(commandId, (latest) => ({
        ...latest,
        possibleAdmission: true,
      }));
      return false;
    }
    const exact = yield* options.decode(call.success.projection);
    yield* recordReceipt(commandId, receipt.admitted, exact.revision);
    yield* updateCommand(commandId, (latest) => ({
      ...latest,
      admitted: receipt.admitted,
      possibleAdmission: true,
      phase: "applied",
      exact,
    }));
    yield* acceptCandidate(exact);
    return true;
  });

  const runCommand = (commandId: CommandId) =>
    Effect.gen(function* () {
      yield* updateWorkers((current) => ({
        ...current,
        activeCommands: current.activeCommands + 1,
        commandStarts: current.commandStarts + 1,
      }));
      yield* updateCommand(commandId, (command) => ({ ...command, running: true }));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
            const current = yield* Ref.get(data);
            const command = current.commands.get(commandId);
            if (command === undefined || command.phase !== "pending") return;
            yield* updateCommand(commandId, (latest) => ({ ...latest, attempts: attempt }));
            const succeeded = yield* runAttempt(commandId);
            if (succeeded) return;
            const after = yield* Ref.get(data);
            const failed = after.commands.get(commandId);
            if (
              failed === undefined ||
              failed.phase === "rejected" ||
              failed.phase === "uncertain"
            ) {
              return;
            }
            if (attempt < options.maxAttempts) yield* Effect.sleep(options.retryDelay);
            else {
              let phase: CommandPhase = "rejected";
              const latestCommand = after.commands.get(commandId);
              if (latestCommand !== undefined && latestCommand.possibleAdmission) {
                phase = "uncertain";
              }
              yield* updateCommand(commandId, (latest) => ({
                ...latest,
                phase,
              }));
            }
          }
        }),
        Effect.gen(function* () {
          yield* updateCommand(commandId, (command) => ({ ...command, running: false }));
          yield* updateWorkers((current) => ({
            ...current,
            activeCommands: current.activeCommands - 1,
            commandStops: current.commandStops + 1,
          }));
        }),
      );
    });

  const startCommand = (commandId: CommandId) => Effect.forkIn(runCommand(commandId), ownerScope);

  const submit = Effect.fn("Reconciliation.submit")(function* (
    commandId: CommandId,
    identity: CommandIdentity,
    message: Message,
    predict: (state: State) => State,
  ) {
    const payload = yield* options.encode(message);
    const current = yield* Ref.get(data);
    const command: StoredCommand<State> = {
      commandId,
      identity,
      payload,
      admitted: undefined,
      attempts: 0,
      possibleAdmission: false,
      phase: "pending",
      exact: undefined,
      predict,
      running: false,
      incorporated: false,
    };
    const commands = new Map(current.commands);
    commands.set(commandId, command);
    let reconciliation = current.reconciliation;
    if (identity === "generated") {
      reconciliation = {
        ...reconciliation,
        visible: predict(reconciliation.visible),
      };
    }
    yield* setData({ ...current, commands, reconciliation });
    yield* startCommand(commandId);
    return publicCommand(command);
  });

  const stream = options.transport
    .changes(options.address, initial.revision)
    .pipe(Stream.mapEffect(options.decode), Stream.runForEach(acceptCandidate));
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* updateWorkers((current) => ({
        ...current,
        activeStream: current.activeStream + 1,
        streamStarts: current.streamStarts + 1,
      }));
      yield* Effect.ensuring(
        stream,
        updateWorkers((current) => ({
          ...current,
          activeStream: current.activeStream - 1,
          streamStops: current.streamStops + 1,
        })),
      );
    }),
  );

  const submitGenerated = (message: Message, predict: (state: State) => State) =>
    Effect.gen(function* () {
      const commandId = decodeCommandId(yield* Effect.orDie(crypto.randomUUIDv4));
      return yield* submit(commandId, "generated", message, predict);
    });

  const submitSupplied = (
    commandId: CommandId,
    message: Message,
    predict: (state: State) => State,
  ) => submit(commandId, "supplied", message, predict);

  const retry = Effect.fn("Reconciliation.retry")(function* (commandId: CommandId) {
    yield* updateCommand(
      commandId,
      (command) => ({
        ...command,
        attempts: 0,
        phase: "pending",
        running: false,
        incorporated: false,
      }),
      true,
    );
    yield* startCommand(commandId);
  });

  return {
    view: SubscriptionRef.get(view),
    changes: SubscriptionRef.changes(view),
    command: (commandId) =>
      Effect.map(Ref.get(data), (current) =>
        Option.fromNullishOr(current.commands.get(commandId)).pipe(Option.map(publicCommand)),
      ),
    workers: Ref.get(workers),
    submitGenerated,
    submitSupplied,
    retry,
  } satisfies ClientCoordinator<State, Message>;
});
