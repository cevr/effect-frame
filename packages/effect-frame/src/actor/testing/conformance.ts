import type { Layer, Scope } from "effect";
import { Cause, Effect, Equal, Exit, Hash, Inspectable, Option, Schema } from "effect";
import type { CommandConflict } from "../vocabulary.js";
import { CommandId } from "../vocabulary.js";
import type { Appended, Committed, StoredReceipt } from "../mailbox-store.js";
import { MailboxStore } from "../mailbox-store.js";

/** The outcome of one conformance case. `detail` explains a failure. */
export interface ConformanceCase {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * The service the `MailboxStore` key resolves to. `MailboxStore.of` is the
 * constructor the key publishes, so its return type is the service itself.
 */
export type StoreService = ReturnType<typeof MailboxStore.of>;

/**
 * Builds a fresh, empty store. Each case takes one. A scoped factory lets a
 * host open and close real storage per case.
 */
export type StoreFactory = Effect.Effect<StoreService, never, Scope.Scope>;

const id = Schema.decodeSync(CommandId);

interface Check {
  readonly ok: boolean;
  readonly detail: string;
}

const show = <A>(value: A): string => Inspectable.toStringUnknown(value);

const equals = <A>(label: string, actual: A, expected: NoInfer<A>): Check => ({
  ok: Equal.equals(actual, expected),
  detail: `${label}: got ${show(actual)}, want ${show(expected)}`,
});

const isTrue = (label: string, actual: boolean): Check => ({
  ok: actual,
  detail: `${label}: got false, want true`,
});

const firstFailure = (checks: ReadonlyArray<Check>): Option.Option<Check> =>
  Option.fromNullishOr(checks.find((check) => !check.ok));

const commandIdOf = (command: Option.Option<{ readonly commandId: CommandId }>) =>
  Option.map(command, (found) => found.commandId);

const receiptFields = (receipt: StoredReceipt) => ({
  commandId: receipt.commandId,
  admitted: receipt.admitted,
  revision: receipt.revision,
  state: receipt.state,
});

const committedFields = (committed: Option.Option<Committed>) =>
  Option.map(committed, (found) => ({ revision: found.revision, state: found.state }));

const duplicateReceipt = (appended: Appended): Option.Option<StoredReceipt> => {
  if (appended._tag === "Duplicate") {
    return appended.receipt;
  }
  return Option.none();
};

const startsEmpty = Effect.fn("Conformance.startsEmpty")(function* (store: StoreService) {
  const next = yield* store.next;
  const pending = yield* store.pending;
  const latest = yield* store.latest;
  return [
    equals("next", next, Option.none()),
    equals("pending", pending, []),
    equals("latest", latest, Option.none()),
  ];
});

const admitsInOrder = Effect.fn("Conformance.admitsInOrder")(function* (store: StoreService) {
  const first = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const second = yield* store.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
  const next = yield* store.next;
  const pending = yield* store.pending;
  return [
    equals("first append", first, { _tag: "Admitted", admitted: 1 }),
    equals("second append", second, { _tag: "Admitted", admitted: 2 }),
    equals("next command", commandIdOf(next), Option.some(id("a"))),
    equals("pending", pending, [id("a"), id("b")]),
  ];
});

const duplicateCarriesReceipt = Effect.fn("Conformance.duplicateCarriesReceipt")(function* (
  store: StoreService,
) {
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const beforeCommit = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const receipt = yield* store.commit(id("a"), "s1", Option.none());
  const afterCommit = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const afterReceipt = Option.map(duplicateReceipt(afterCommit), receiptFields);
  return [
    equals("duplicate before commit", beforeCommit, {
      _tag: "Duplicate",
      admitted: 1,
      receipt: Option.none(),
    }),
    equals("duplicate tag after commit", afterCommit._tag, "Duplicate"),
    equals("duplicate receipt after commit", afterReceipt, Option.some(receiptFields(receipt))),
  ];
});

const conflictRejectsNewPayload = Effect.fn("Conformance.conflictRejectsNewPayload")(function* (
  store: StoreService,
) {
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const outcome = yield* Effect.exit(
    store.append({ commandId: id("a"), payload: "2", payloadHash: 2 }),
  );
  const pending = yield* store.pending;
  const failure = Option.map(Exit.findErrorOption(outcome), (conflict) => ({
    tag: conflict._tag,
    commandId: conflict.commandId,
  }));
  return [
    equals("append fails", failure, Option.some({ tag: "CommandConflict", commandId: id("a") })),
    equals("pending unchanged", pending, [id("a")]),
  ];
});

/**
 * Two payloads whose `Hash.string` values are equal. The engine hashes a
 * payload with `Hash.string`, so a store that trusts the hash alone would
 * answer `Duplicate` for the second under the first one's ID.
 */
const collidingPayloads: readonly [string, string] = ['{"title":"00008t"}', '{"title":"0000fj"}'];

const conflictDespiteEqualHash = Effect.fn("Conformance.conflictDespiteEqualHash")(function* (
  store: StoreService,
) {
  const [first, second] = collidingPayloads;
  const firstHash = Hash.string(first);
  const secondHash = Hash.string(second);
  const conflictOf = (outcome: Exit.Exit<Appended, CommandConflict>) =>
    Option.map(Exit.findErrorOption(outcome), (conflict) => ({
      tag: conflict._tag,
      commandId: conflict.commandId,
    }));
  yield* store.append({ commandId: id("a"), payload: first, payloadHash: firstHash });
  const whilePending = yield* Effect.exit(
    store.append({ commandId: id("a"), payload: second, payloadHash: secondHash }),
  );
  yield* store.commit(id("a"), "s1", Option.none());
  const afterCommit = yield* Effect.exit(
    store.append({ commandId: id("a"), payload: second, payloadHash: secondHash }),
  );
  const same = yield* store.append({ commandId: id("a"), payload: first, payloadHash: firstHash });
  const pending = yield* store.pending;
  return [
    equals("the two payloads share a hash", firstHash, secondHash),
    equals(
      "append while pending fails",
      conflictOf(whilePending),
      Option.some({ tag: "CommandConflict", commandId: id("a") }),
    ),
    equals(
      "append after commit fails",
      conflictOf(afterCommit),
      Option.some({ tag: "CommandConflict", commandId: id("a") }),
    ),
    equals("the first payload is still a duplicate", same._tag, "Duplicate"),
    equals("pending", pending, []),
  ];
});

const commitAdvancesRevision = Effect.fn("Conformance.commitAdvancesRevision")(function* (
  store: StoreService,
) {
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  yield* store.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
  const first = yield* store.commit(id("a"), "s1", Option.none());
  const latest = yield* store.latest;
  const next = yield* store.next;
  const second = yield* store.commit(id("b"), "s2", Option.none());
  const drained = yield* store.next;
  const pending = yield* store.pending;
  return [
    equals("first receipt", receiptFields(first), {
      commandId: id("a"),
      admitted: 1,
      revision: 1,
      state: "s1",
    }),
    equals(
      "latest after first",
      committedFields(latest),
      Option.some({ revision: 1, state: "s1" }),
    ),
    equals("next after first", commandIdOf(next), Option.some(id("b"))),
    equals("second revision", second.revision, 2),
    equals("next after second", drained, Option.none()),
    equals("pending after second", pending, []),
  ];
});

const advanceSharesTheClock = Effect.fn("Conformance.advanceSharesTheClock")(function* (
  store: StoreService,
) {
  const first = yield* store.advance("s1", Option.none());
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const receipt = yield* store.commit(id("a"), "s2", Option.none());
  const third = yield* store.advance("s3", Option.none());
  const latest = yield* store.latest;
  const pending = yield* store.pending;
  return [
    equals(
      "first advance",
      { revision: first.revision, state: first.state },
      {
        revision: 1,
        state: "s1",
      },
    ),
    equals("commit revision", receipt.revision, 2),
    equals("third advance revision", third.revision, 3),
    equals("latest", committedFields(latest), Option.some({ revision: 3, state: "s3" })),
    equals("pending", pending, []),
  ];
});

const receiptIsStable = Effect.fn("Conformance.receiptIsStable")(function* (store: StoreService) {
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const beforeCommit = yield* store.receipt(id("a"));
  const missing = yield* store.receipt(id("missing"));
  const receipt = yield* store.commit(id("a"), "s1", Option.none());
  const readOnce = yield* store.receipt(id("a"));
  const readTwice = yield* store.receipt(id("a"));
  const want = Option.some(receiptFields(receipt));
  return [
    equals("receipt before commit", beforeCommit, Option.none()),
    equals("receipt of unknown command", missing, Option.none()),
    equals("receipt after commit", Option.map(readOnce, receiptFields), want),
    equals("receipt read twice", Option.map(readTwice, receiptFields), want),
  ];
});

const drainsPendingOnReopen = Effect.fn("Conformance.drainsPendingOnReopen")(function* (
  store: StoreService,
) {
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  yield* store.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
  const firstPending = yield* store.next;
  yield* store.commit(id("a"), "s1", Option.none());
  const secondPending = yield* store.next;
  const pending = yield* store.pending;
  const latest = yield* store.latest;
  return [
    equals("first pending", commandIdOf(firstPending), Option.some(id("a"))),
    equals("second pending", commandIdOf(secondPending), Option.some(id("b"))),
    equals("pending list", pending, [id("b")]),
    isTrue("latest is present", Option.isSome(latest)),
  ];
});

/**
 * The command owner's bound: eight passes, each one admission request
 * and one same-ID call. A store takes no clock, so the bound it sees is
 * counted in the requests those passes make, not in time.
 */
const retryPasses = 8;

const neverReadmits = Effect.fn("Conformance.neverReadmits")(function* (store: StoreService) {
  const first = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const whilePending = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const receipt = yield* store.commit(id("a"), "s1", Option.none());
  yield* store.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
  yield* store.commit(id("b"), "s2", Option.none());
  yield* store.advance("s3", Option.none());
  const afterCommit = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const pending = yield* store.pending;
  const next = yield* store.next;
  const fresh = yield* store.append({ commandId: id("c"), payload: "3", payloadHash: 3 });
  return [
    equals("first append", first, { _tag: "Admitted", admitted: 1 }),
    equals("append while pending", whilePending, {
      _tag: "Duplicate",
      admitted: 1,
      receipt: Option.none(),
    }),
    equals("append after commit, later commands, and an advance", afterCommit._tag, "Duplicate"),
    equals(
      "the duplicate keeps the first admission and its receipt",
      {
        admitted: afterCommit.admitted,
        receipt: Option.map(duplicateReceipt(afterCommit), receiptFields),
      },
      { admitted: 1, receipt: Option.some(receiptFields(receipt)) },
    ),
    equals("nothing pending after the re-send", pending, []),
    equals("no next command after the re-send", next, Option.none()),
    // A re-send consumed no admission number.
    equals("a new ID takes the next admission", fresh, { _tag: "Admitted", admitted: 3 }),
  ];
});

const receiptOutlivesRetryBound = Effect.fn("Conformance.receiptOutlivesRetryBound")(function* (
  store: StoreService,
) {
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const receipt = yield* store.commit(id("a"), "s1", Option.none());
  const want = Option.some(receiptFields(receipt));
  const checks: Array<Check> = [];
  // Every pass of the bound re-sends the command and reads its receipt,
  // while the actor keeps committing other commands and its own changes.
  for (let pass = 1; pass <= retryPasses; pass += 1) {
    const resent = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
    const read = yield* store.receipt(id("a"));
    const other = id(`other-${String(pass)}`);
    yield* store.append({ commandId: other, payload: String(pass), payloadHash: pass + 100 });
    yield* store.commit(other, `other-${String(pass)}`, Option.none());
    yield* store.advance(`autonomous-${String(pass)}`, Option.none());
    checks.push(
      equals(
        `pass ${String(pass)} re-send`,
        Option.map(duplicateReceipt(resent), receiptFields),
        want,
      ),
      equals(`pass ${String(pass)} receipt`, Option.map(read, receiptFields), want),
    );
  }
  // The bound is spent. A manual retry of the same ID still finds the receipt.
  const retried = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  const read = yield* store.receipt(id("a"));
  checks.push(
    equals("retry after the bound", retried._tag, "Duplicate"),
    equals("retry receipt", Option.map(duplicateReceipt(retried), receiptFields), want),
    equals("receipt after the bound", Option.map(read, receiptFields), want),
  );
  return checks;
});

/**
 * The wake is part of the committed state: it is stored in the
 * same step, read back with `latest`, and replaced by the next commit, so a
 * later state that waits for nothing clears an earlier deadline.
 */
const wakeFollowsTheLatestCommit = Effect.fn("Conformance.wakeFollowsTheLatestCommit")(function* (
  store: StoreService,
) {
  const advanced = yield* store.advance("s1", Option.some(1_000));
  const afterAdvance = yield* store.latest;
  yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
  yield* store.commit(id("a"), "s2", Option.some(2_000));
  const afterCommit = yield* store.latest;
  yield* store.advance("s3", Option.none());
  const cleared = yield* store.latest;
  const wakeOf = (latest: Option.Option<Committed>) => Option.map(latest, (found) => found.wake);
  return [
    equals("advance returns its wake", advanced.wake, Option.some(1_000)),
    equals("latest after the advance", wakeOf(afterAdvance), Option.some(Option.some(1_000))),
    equals("latest after the commit", wakeOf(afterCommit), Option.some(Option.some(2_000))),
    equals("a state with no wake clears it", wakeOf(cleared), Option.some(Option.none())),
  ];
});

interface Definition {
  readonly name: string;
  /** A case may fail; `runCase` turns any failure into a failed check. */
  readonly run: (store: StoreService) => Effect.Effect<ReadonlyArray<Check>, CommandConflict>;
}

const definitions: ReadonlyArray<Definition> = [
  { name: "starts empty", run: startsEmpty },
  { name: "append admits in order and next returns the oldest command", run: admitsInOrder },
  { name: "a duplicate append carries the stored receipt", run: duplicateCarriesReceipt },
  {
    name: "a new payload under a used ID fails with CommandConflict",
    run: conflictRejectsNewPayload,
  },
  {
    name: "a new payload with an equal hash under a used ID fails with CommandConflict",
    run: conflictDespiteEqualHash,
  },
  {
    name: "commit advances one monotonic revision and updates latest",
    run: commitAdvancesRevision,
  },
  {
    name: "advance commits with no command and shares the revision clock",
    run: advanceSharesTheClock,
  },
  { name: "receipt is absent until commit and stable after it", run: receiptIsStable },
  { name: "next walks pending commands in admission order", run: drainsPendingOnReopen },
  { name: "a seen command ID is never admitted again", run: neverReadmits },
  { name: "a receipt outlives the retry bound", run: receiptOutlivesRetryBound },
  { name: "the wake is stored with the latest commit", run: wakeFollowsTheLatestCommit },
];

const runCase = Effect.fn("Conformance.runCase")(function* (
  factory: StoreFactory,
  definition: Definition,
) {
  const outcome = yield* Effect.exit(Effect.scoped(Effect.flatMap(factory, definition.run)));
  if (Exit.isFailure(outcome)) {
    return {
      name: definition.name,
      passed: false,
      detail: `the case failed: ${Cause.pretty(outcome.cause)}`,
    } satisfies ConformanceCase;
  }
  const checks = outcome.value;
  const failure = firstFailure(checks);
  return Option.match(failure, {
    onNone: (): ConformanceCase => ({
      name: definition.name,
      passed: true,
      detail: `${checks.length} checks passed`,
    }),
    onSome: (check): ConformanceCase => ({
      name: definition.name,
      passed: false,
      detail: check.detail,
    }),
  });
});

/**
 * The conformance suite every `MailboxStore` implementation must pass. The
 * factory must build a fresh, empty store, because each case runs alone. The
 * result never fails; read `passed` on each case.
 */
export const mailboxStoreConformance = Effect.fn("Conformance.mailboxStore")(function* (
  factory: StoreFactory,
) {
  return yield* Effect.forEach(definitions, (definition) => runCase(factory, definition));
});

/** Turns a layer that builds a fresh store into a factory the suite accepts. */
export const factoryFromLayer = (layer: Layer.Layer<MailboxStore>): StoreFactory =>
  // Each conformance case is its own entry point: it needs a fresh store with
  // its own lifetime, so the layer is built here and nowhere higher.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(MailboxStore, layer);

export * as QueryTest from "./query.js";
export * as HttpTest from "./http.js";
