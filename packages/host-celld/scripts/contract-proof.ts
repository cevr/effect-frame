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
 *
 * Nothing here runs in CI: it needs the binary and takes about a minute.
 * Run it with `bun run proof:contract`.
 *
 * This file is a test runner, not library code. It uses the process APIs a
 * runner needs at its edges; the actor calls inside are ordinary Effect.
 */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scope } from "effect";
import { Duration, Effect, Fiber, Option, Schema, Stream } from "effect";
import { CommandId, HttpTransport, ref } from "@effect-frame/actor/client";
import type { RemoteActorRef } from "@effect-frame/actor/client";
import { Counter, Upload, UploadEvent } from "../fixture-contract/index.js";
import type { Node } from "./celld-process.js";
import { crash, celldBin, freePort, makeReport, sleep, start, stop } from "./celld-process.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

const proofDir = join(repoRoot, ".proof", "celld-contract");
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
    first.revision === 1 && first.state === 3,
    `applied ${show(first)}`,
  );

  await crash(node);
  const restarted = await start(proofDir, port);

  const restored = await runCounter(restarted.port, key, (counter) => counter.applied.get);
  report.check(
    "e",
    "after SIGKILL and restart the committed state is restored",
    restored.revision === 1 && restored.state === 3,
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
    retried.revision === 1 && retried.state === 3,
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
    next.revision === 2 && next.state === 8,
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
    Effect.orDie(Effect.flip(counter.send({ _tag: "Add", amount: 99 }, { commandId: id("e1") }))),
  );
  report.check(
    "f",
    "the same ID with a different payload is a typed CommandConflict",
    failure._tag === "CommandConflict",
    `failure ${show(failure)}`,
  );

  const state = await runCounter(node.port, key, (counter) => counter.applied.get);
  report.check(
    "f",
    "the rejected command left the committed state alone",
    state.revision === 2 && state.state === 8,
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
  const uploadingAt = started.revision;
  report.check(
    "g",
    "the Start command commits Uploading",
    started.state._tag === "Uploading",
    `applied ${show(started)}`,
  );

  // Kill well inside the task's sleep, so the work cannot have finished.
  await sleep(500);
  await crash(node);
  const restarted = await start(proofDir, port);

  // One snapshot request wakes the object. This is exactly what a
  // reconnecting client sends first.
  const wokeAt = Date.now();
  const woken = await runUpload(restarted.port, key, (upload) => upload.applied.get);
  report.check(
    "g",
    "the wake snapshot shows the machine still in Uploading, work unfinished",
    woken.revision === uploadingAt && woken.state._tag === "Uploading",
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
      applied.value.revision === uploadingAt + 1 &&
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
    settled.revision === uploadingAt + 1 && settled.state._tag === "Done",
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
          Stream.filter(counter.applied.changes, (committed) => committed.revision === 1),
        ),
      );
      // Let the subscription open before the command changes the revision.
      yield* Effect.sleep(Duration.millis(300));
      yield* Effect.orDie(counter.send({ _tag: "Add", amount: 4 }, { commandId: id("h1") }));
      return yield* Effect.timeoutOption(Fiber.join(waiting), Duration.seconds(15));
    }),
  );
  const applied = Option.flatten(seen);
  report.check(
    "h",
    "the changes event stream delivers the new revision over the wire",
    Option.isSome(applied) && applied.value.revision === 1 && applied.value.state === 4,
    `event ${show(Option.getOrUndefined(applied))}`,
  );
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const prepare = (): void => {
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  cpSync(join(fixtureSource, "worker.js"), join(proofDir, "worker.js"));
  cpSync(join(fixtureSource, "wrangler.jsonc"), join(proofDir, "wrangler.jsonc"));
};

const main = async (): Promise<number> => {
  console.log(`celld binary: ${celldBin}`);
  console.log(`proof dir:    ${proofDir}`);
  console.log("");
  prepare();

  const port = await freePort();
  let node = await start(proofDir, port);
  try {
    console.log("rows:");
    node = await rowCounterSurvivesKill(node);
    await rowConflict(node);
    node = await rowMachineResumes(node);
    await rowChangesStream(node);
  } finally {
    await stop(node);
  }
  return report.print();
};

process.exitCode = await main();
