/**
 * The generic host proof.
 *
 * It runs the real celld 0.5.0 binary against the generic `FrameHost` fixture
 * and talks to it with the real `HttpTransport` client and `ref`, over the
 * generic actor wire. Nothing here knows the host is a Durable Object: the
 * client sees `POST /send`, `POST /call`, `POST /snapshot`, and the
 * `GET /changes` event stream, and nothing else.
 *
 * Rows:
 *   e  Counter: committed state and the stored receipt survive SIGKILL.
 *   f  Counter: the same ID with a different payload is a CommandConflict.
 *   g  Upload: machine work interrupted by SIGKILL runs again after a wake.
 *   h  changes: a revision arrives as an event over the wire.
 *   i  Job: work in flight at SIGKILL finishes with no request (#101 §5),
 *      across several of the host's alarm holds.
 *   j  Reminder: a deadline fires at its stored time with no request, even
 *      when part of the wait passed while the node was down.
 *
 * Rows i and j observe with no request, so no request can have woken the
 * object: workerd's objects are read on disk, and celld's output is read for
 * the host's `FrameHost.wake settled` line, which follows the commit, because
 * celld's storage is not plain SQLite on disk.
 *
 * Nothing here runs in CI: it needs the binary and takes about a minute.
 * Run it with `bun run proof:contract`.
 *
 * This file is a test runner, not library code. It uses the process APIs a
 * runner needs at its edges; the actor calls inside are ordinary Effect.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scope } from "effect";
import { Duration, Effect, Fiber, Option, Schedule, Schema, Stream } from "effect";
import { CommandId, HttpTransport, ref } from "effect-frame/actor/client";
import type { AnyContract, KeyOf, RemoteActorRef } from "effect-frame/actor/client";
import {
  Counter,
  Job,
  JobEvent,
  Reminder,
  ReminderEvent,
  Upload,
  UploadEvent,
} from "../fixture-contract/index.js";
import type { Node } from "./proof.js";
import { freePort, makeReport, prepare, sleep } from "./proof.js";
import { runtimeFromArgs } from "./runtimes.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

const runtime = runtimeFromArgs(process.argv);
const proofDir = join(repoRoot, ".proof", `${runtime.name}-contract`);
const fixtureSource = join(packageRoot, "fixture-contract");

const report = makeReport();
const id = Schema.decodeSync(CommandId);
const show = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * One transport per address. The worker routes on the path, and the client
 * posts to a fixed path under its base URL, so the address lives in the base
 * URL. The key segment is the JSON-encoded key the address carries.
 */
const transportFor = (port: number, name: string, version: number, key: string) =>
  HttpTransport.layer({
    baseUrl: `http://127.0.0.1:${port}/actors/${name}/${version}/${encodeURIComponent(
      JSON.stringify(key),
    )}`,
    reconnect: HttpTransport.defaultReconnect,
  });

// ---------------------------------------------------------------------------
// Row e — Counter survives the kill
// ---------------------------------------------------------------------------

type CounterRef = RemoteActorRef<typeof Counter>;

const counterRef = (key: string) => ref(Counter, key);

const rowCounterSurvivesKill = async (node: Node): Promise<Node> => {
  const key = "row-e";
  const port = node.port;

  const first = await runCounter(port, key, (counter) =>
    Effect.orDie(
      counter.call({ _tag: "Add", amount: 3 }, { commandId: id("e1"), timeout: "8 seconds" }),
    ),
  );
  report.check(
    "e",
    "a call over the generic wire commits and returns revision 1",
    first.revision.value === 1 && first.state === 3,
    `applied ${show(first)}`,
  );

  await node.crash();
  const restarted = await runtime.start(proofDir, port);

  const restored = await runCounter(restarted.port, key, (counter) => counter.applied.get);
  report.check(
    "e",
    "after SIGKILL and restart the committed state is restored",
    restored.revision.value === 1 && restored.state === 3,
    `applied ${show(restored)}`,
  );

  const retried = await runCounter(restarted.port, key, (counter) =>
    Effect.orDie(
      counter.call({ _tag: "Add", amount: 3 }, { commandId: id("e1"), timeout: "8 seconds" }),
    ),
  );
  report.check(
    "e",
    "the retried command ID returns the stored receipt and does not reapply",
    retried.revision.value === 1 && retried.state === 3,
    `applied ${show(retried)}`,
  );

  const next = await runCounter(restarted.port, key, (counter) =>
    Effect.orDie(
      counter.call({ _tag: "Add", amount: 5 }, { commandId: id("e2"), timeout: "8 seconds" }),
    ),
  );
  report.check(
    "e",
    "a new command after the restart reaches revision 2 and state 8",
    next.revision.value === 2 && next.state === 8,
    `applied ${show(next)}`,
  );
  return restarted;
};

const runCounter = <A>(
  port: number,
  key: string,
  use: (counter: CounterRef) => Effect.Effect<A, never, Scope.Scope>,
): Promise<A> =>
  // The address is a run-time value; the client layer is built per call.
  // oxlint-disable-next-line effect/noInlineProvide
  Effect.runPromise(
    Effect.scoped(
      // Each proof step is its own entry point: one process, one transport, one scope.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(
        Effect.flatMap(Effect.orDie(counterRef(key)), use),
        transportFor(port, Counter.name, Counter.version, key),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Row f — the conflict crosses the wire as a 409
// ---------------------------------------------------------------------------

const rowConflict = async (node: Node): Promise<void> => {
  const key = "row-e";
  const failure = await runCounter(node.port, key, (counter) =>
    Effect.flatMap(
      counter.send({ _tag: "Add", amount: 99 }, { commandId: id("e1") }),
      (handle) => handle.settled,
    ),
  );
  report.check(
    "f",
    "the same ID with a different payload settles Rejected with a typed CommandConflict",
    failure._tag === "Rejected" && failure.reason._tag === "CommandConflict",
    `settled ${show(failure)}`,
  );

  const state = await runCounter(node.port, key, (counter) => counter.applied.get);
  report.check(
    "f",
    "the rejected command left the committed state alone",
    state.revision.value === 2 && state.state === 8,
    `applied ${show(state)}`,
  );
};

// ---------------------------------------------------------------------------
// Row g — machine work resumes after the kill
// ---------------------------------------------------------------------------

const uploadMillis = 4000;

/**
 * A machine spends one revision before any command: `Behavior.machine` emits
 * the state it hydrated on `changes`, and the durable actor commits that as
 * an autonomous advance. A fresh machine therefore commits `Idle` as revision
 * 1 and the first command lands at revision 2. The proof asserts the
 * relations between revisions, not fixed numbers, so it measures recovery and
 * not that starting cost.
 */
const rowMachineResumes = async (node: Node): Promise<Node> => {
  const key = "row-g";
  const port = node.port;

  const started = await runUpload(port, key, (upload) =>
    Effect.orDie(
      upload.call(UploadEvent.Start({ file: "a.txt", millis: uploadMillis }), {
        commandId: id("g1"),
        timeout: "8 seconds",
      }),
    ),
  );
  const uploadingAt = started.revision.value;
  report.check(
    "g",
    "the Start command commits Uploading",
    started.state._tag === "Uploading",
    `applied ${show(started)}`,
  );

  // Kill well inside the task's sleep, so the work cannot have finished.
  await sleep(500);
  await node.crash();
  const restarted = await runtime.start(proofDir, port);

  // One snapshot request wakes the object. This is exactly what a
  // reconnecting client sends first.
  const wokeAt = Date.now();
  const woken = await runUpload(restarted.port, key, (upload) => upload.applied.get);
  report.check(
    "g",
    "the wake snapshot shows the machine still in Uploading, work unfinished",
    woken.revision.value === uploadingAt && woken.state._tag === "Uploading",
    `applied ${show(woken)}`,
  );

  // Subscribe and wait for the transition the re-run task commits.
  const done = await runUpload(restarted.port, key, (upload) =>
    Effect.timeoutOption(
      Stream.runHead(
        Stream.filter(upload.applied.changes, (committed) => committed.state._tag === "Done"),
      ),
      Duration.seconds(20),
    ),
  );
  const elapsed = Date.now() - wokeAt;
  const applied = Option.flatten(done);
  report.check(
    "g",
    "machine work resumed after the restart and committed Done one revision on",
    Option.isSome(applied) &&
      applied.value.revision.value === uploadingAt + 1 &&
      applied.value.state._tag === "Done",
    `applied ${show(Option.getOrUndefined(applied))}`,
  );
  report.check(
    "g",
    "Done arrived one full task run after the wake, so the work re-ran",
    elapsed >= uploadMillis - 500,
    `Done arrived ${elapsed} ms after the wake; one run takes ${uploadMillis} ms`,
  );

  const settled = await runUpload(restarted.port, key, (upload) => upload.applied.get);
  report.check(
    "g",
    "the snapshot after the resume is Done, so the mailbox drained",
    settled.revision.value === uploadingAt + 1 && settled.state._tag === "Done",
    `applied ${show(settled)}`,
  );
  return restarted;
};

type UploadRef = RemoteActorRef<typeof Upload>;

const runUpload = <A>(
  port: number,
  key: string,
  use: (upload: UploadRef) => Effect.Effect<A, never, Scope.Scope>,
): Promise<A> =>
  // oxlint-disable-next-line effect/noInlineProvide
  Effect.runPromise(
    Effect.scoped(
      // Each proof step is its own entry point: one process, one transport, one scope.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(
        Effect.flatMap(Effect.orDie(ref(Upload, key)), use),
        transportFor(port, Upload.name, Upload.version, key),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Row h — the changes stream over the wire
// ---------------------------------------------------------------------------

const rowChangesStream = async (node: Node): Promise<void> => {
  const key = "row-h";
  const seen = await runCounter(node.port, key, (counter) =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkScoped(
        Stream.runHead(
          Stream.filter(counter.applied.changes, (committed) => committed.revision.value === 1),
        ),
      );
      // Let the subscription open before the command changes the revision.
      yield* Effect.sleep(Duration.millis(300));
      yield* counter.send({ _tag: "Add", amount: 4 }, { commandId: id("h1") });
      return yield* Effect.timeoutOption(Fiber.join(waiting), Duration.seconds(15));
    }),
  );
  const applied = Option.flatten(seen);
  report.check(
    "h",
    "the changes event stream delivers the new revision over the wire",
    Option.isSome(applied) && applied.value.revision.value === 1 && applied.value.state === 4,
    `event ${show(Option.getOrUndefined(applied))}`,
  );
};

// ---------------------------------------------------------------------------
// Rows i and j — a wake with no request
// ---------------------------------------------------------------------------

const runRef = <C extends AnyContract, A>(
  port: number,
  actor: C,
  key: KeyOf<C>,
  use: (handle: RemoteActorRef<C>) => Effect.Effect<A, never, Scope.Scope>,
): Promise<A> =>
  // oxlint-disable-next-line effect/noInlineProvide
  Effect.runPromise(
    Effect.scoped(
      // Each proof step is its own entry point: one process, one transport, one scope.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(
        Effect.flatMap(Effect.orDie(ref(actor, key)), use),
        transportFor(port, actor.name, actor.version, String(key)),
      ),
    ),
  );

/**
 * What an observer saw with no request: the committed row on disk, or the
 * fixture's log line in the runtime's output. `wake` is the committed wake,
 * known only on disk; `firedAt` is the reminder's fire time, when it has one.
 */
interface Seen {
  readonly source: "disk" | "log";
  readonly wake: Option.Option<Option.Option<number>>;
  readonly firedAt: Option.Option<number>;
}

/** The columns a disk observer reads from one object's `committed` row. */
const DiskRow = Schema.Struct({
  wake_at: Schema.OptionFromNullOr(Schema.Finite),
  state: Schema.fromJsonString(Schema.Struct({ firedAt: Schema.optionalKey(Schema.Finite) })),
});
const decodeDiskRow = Schema.decodeUnknownOption(DiskRow);

const fromDisk = (row: unknown): Option.Option<Seen> =>
  Option.map(decodeDiskRow(row), (decoded) => ({
    source: "disk",
    wake: Option.some(decoded.wake_at),
    firedAt: Option.fromNullishOr(decoded.state.firedAt),
  }));

/** The reminder's fire time, which the fixture logs from its task. */
const firedAtPattern = /fixture\.reminder at=\d+ firedAt=(?<firedAt>\d+)/;

const fromLog = (logs: string): Seen => ({
  source: "log",
  wake: Option.none(),
  firedAt: Option.map(
    Option.flatMap(Option.fromNullishOr(firedAtPattern.exec(logs)), (found) =>
      Option.fromNullishOr(found.groups?.["firedAt"]),
    ),
    Number,
  ),
});

/**
 * The host's line when an alarm's hold ends with nothing due. The host reads
 * the committed revision from storage for it, so it follows the commit.
 */
const settledLine = (contract: string, revision: number): RegExp =>
  new RegExp(`FrameHost\\.wake settled contract=${contract} revision=${revision}\\b`);

/** How many times the host re-armed a hold that ended with work still due. */
const rearms = (node: Node, contract: string): number =>
  node.logs.join("").split(`FrameHost.wake rearmed contract=${contract} `).length - 1;

/**
 * One look, with no request. A runtime with a disk reader (workerd) is read
 * on disk: a committed state holds `tag`. One without (celld) is read in its
 * output: the host logs `settled` once the commit left nothing due.
 */
const lookOnce = (node: Node, tag: string, settled: RegExp): Effect.Effect<Option.Option<Seen>> =>
  Effect.sync(() =>
    Option.match(Option.fromNullishOr(runtime.readObjects), {
      onSome: (readObjects) =>
        Option.flatMap(
          Option.fromNullishOr(
            readObjects(
              proofDir,
              `SELECT wake_at, state FROM committed WHERE state LIKE '%"_tag":"${tag}"%'`,
            )[0],
          ),
          fromDisk,
        ),
      onNone: () => {
        const logs = node.logs.join("");
        return Option.map(
          Option.liftPredicate(logs, (text) => settled.test(text)),
          fromLog,
        );
      },
    }),
  );

/** Looks every 100 ms until the object reports progress or the wait runs out. */
const observe = (
  node: Node,
  tag: string,
  settled: RegExp,
  timeout: Duration.Input,
): Promise<Option.Option<Seen>> =>
  Effect.runPromise(
    lookOnce(node, tag, settled).pipe(
      Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("100 millis") }),
      Effect.timeoutOption(timeout),
      Effect.map(Option.flatten),
    ),
  );

const jobSteps = 5;
const jobStepMillis = 1500;

const rowJobFinishesAlone = async (node: Node): Promise<Node> => {
  const key = "row-i";
  const started = await runRef(node.port, Job, key, (job) =>
    Effect.orDie(
      job.call(JobEvent.Start({ total: jobSteps, stepMillis: jobStepMillis }), {
        commandId: id("i1"),
        timeout: "8 seconds",
      }),
    ),
  );
  const startedAt = started.revision.value;
  report.check(
    "i",
    "the Start command commits Running",
    started.state._tag === "Running",
    `applied ${show(started)}`,
  );

  // Kill inside the second step: one step committed, one in flight.
  await sleep(jobStepMillis + 700);
  await node.crash();
  const restarted = await runtime.start(proofDir, node.port);

  const finished = await observe(
    restarted,
    "Finished",
    settledLine(Job.name, startedAt + jobSteps),
    "30 seconds",
  );
  report.check(
    "i",
    "with no request after the restart, the job finishes on its own",
    Option.isSome(finished),
    `seen ${show(Option.getOrUndefined(finished))}`,
  );
  // The fixture's hold is 2 seconds and the job needs longer than that
  // after the restart, so it finished only because a hold re-armed.
  report.check(
    "i",
    "the job ran across a hold's end: the host re-armed and carried on",
    rearms(restarted, Job.name) >= 1,
    `${rearms(restarted, Job.name)} re-arms in the output`,
  );
  // Only a disk observer sees the committed wake.
  const finishedWake = Option.flatMap(finished, (seen) => seen.wake);
  if (Option.isSome(finishedWake)) {
    report.check(
      "i",
      "the finished state names no wake",
      Option.isNone(finishedWake.value),
      `wake ${show(finishedWake.value)}`,
    );
  }

  const settled = await runRef(restarted.port, Job, key, (job) =>
    Effect.timeoutOption(
      Stream.runHead(
        Stream.filter(job.applied.changes, (committed) => committed.state._tag === "Finished"),
      ),
      Duration.seconds(30),
    ),
  );
  const applied = Option.flatten(settled);
  report.check(
    "i",
    "one revision per step: no committed step ran twice",
    Option.isSome(applied) && applied.value.revision.value === startedAt + jobSteps,
    `applied ${show(Option.getOrUndefined(applied))}, want revision ${startedAt + jobSteps}`,
  );
  return restarted;
};

const reminderLeadMillis = 6000;

const rowReminderFiresOnTime = async (node: Node): Promise<Node> => {
  const key = "row-j";
  const at = Date.now() + reminderLeadMillis;
  const scheduled = await runRef(node.port, Reminder, key, (reminder) =>
    Effect.orDie(
      reminder.call(ReminderEvent.Schedule({ at }), {
        commandId: id("j1"),
        timeout: "8 seconds",
      }),
    ),
  );
  report.check(
    "j",
    "the Schedule command commits Scheduled",
    scheduled.state._tag === "Scheduled",
    `applied ${show(scheduled)}`,
  );

  // The admission armed an alarm for now. Let it run and end before the
  // kill: an admission alarm still armed at the kill would wake the object
  // after the restart by itself, and the row would not show that the
  // committed wake did. With `wakeAt` removed, this row fails.
  await sleep(1000);
  // Down for part of the wait: a restart that restarted the full delay
  // would fire about this long after the stored time.
  await node.crash();
  await sleep(1500);
  const restartedAt = Date.now();
  const restarted = await runtime.start(proofDir, node.port);
  const late = restartedAt + reminderLeadMillis - at;

  const fired = await observe(
    restarted,
    "Fired",
    settledLine(Reminder.name, scheduled.revision.value + 1),
    "30 seconds",
  );
  const firedAt = Option.getOrElse(
    Option.flatMap(fired, (seen) => seen.firedAt),
    () => Number.NaN,
  );
  report.check(
    "j",
    "with no request after the restart, the reminder fires on its own",
    Option.isSome(fired),
    `seen ${show(Option.getOrUndefined(fired))}`,
  );
  report.check(
    "j",
    "it fires at the stored time, not a full wait after the restart",
    firedAt >= at && firedAt - at < Math.min(1500, late - 500),
    `fired ${firedAt - at} ms after the stored time; a restarted wait would be ${late} ms late`,
  );

  const settled = await runRef(restarted.port, Reminder, key, (reminder) =>
    Effect.timeoutOption(
      Stream.runHead(
        Stream.filter(reminder.applied.changes, (committed) => committed.state._tag === "Fired"),
      ),
      Duration.seconds(30),
    ),
  );
  const applied = Option.flatten(settled);
  report.check(
    "j",
    "a client that reads afterwards sees Fired",
    Option.isSome(applied) && applied.value.state._tag === "Fired",
    `applied ${show(Option.getOrUndefined(applied))}`,
  );
  return restarted;
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const main = async (): Promise<number> => {
  console.log(`runtime:   ${runtime.describe}`);
  console.log(`proof dir: ${proofDir}`);
  console.log("");
  prepare(fixtureSource, proofDir);

  let node = await runtime.start(proofDir, await freePort());
  try {
    console.log("rows:");
    node = await rowCounterSurvivesKill(node);
    await rowConflict(node);
    node = await rowMachineResumes(node);
    await rowChangesStream(node);
    node = await rowJobFinishesAlone(node);
    node = await rowReminderFiresOnTime(node);
  } finally {
    await node.stop();
  }
  return report.print();
};

process.exitCode = await main();
