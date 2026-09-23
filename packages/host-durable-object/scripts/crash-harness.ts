/**
 * The Durable Object recovery proof.
 *
 * It runs a real runtime against an isolated copy of the fixture, kills it
 * with SIGKILL between phases, restarts the same command, and asserts what
 * must survive. `--runtime=celld` (the default) runs the celld 0.5.0 binary;
 * `--runtime=workerd` runs the workerd build Alchemy runs locally. Nothing
 * here runs in CI: it takes about half a minute. Run it with
 * `bun run proof:celld` or `bun run proof:workerd`.
 *
 * This file is a test runner, not library code. It uses plain promises and the
 * process APIs a runner needs.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlRow } from "../src/storage.js";
import type { Node } from "./proof.js";
import { freePort, makeReport, prepare, sleep } from "./proof.js";
import { runtimeFromArgs } from "./runtimes.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

const runtime = runtimeFromArgs(process.argv);
const proofDir = join(repoRoot, ".proof", runtime.name);
const fixtureSource = join(packageRoot, "fixture");

const report = makeReport();
const check = report.check;

// ---------------------------------------------------------------------------
// The HTTP client
// ---------------------------------------------------------------------------

/** The JSON object a fixture reply carries. The harness reads named fields. */
interface ReplyBody {
  readonly revision?: unknown;
  readonly state?: unknown;
  readonly pending?: unknown;
  readonly admitted?: unknown;
  readonly error?: unknown;
  readonly raw?: unknown;
}

interface Reply {
  readonly status: number;
  readonly body: ReplyBody;
}

/** Reads a JSON reply. A body this harness cannot read becomes a raw row. */
const parseBody = (text: string): ReplyBody => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return { ...parsed };
    }
    return { raw: text };
  } catch {
    return { raw: text };
  }
};

const call = async (port: number, key: string, path: string, body?: unknown): Promise<Reply> => {
  const url = `http://127.0.0.1:${port}/actor/${key}${path}`;
  const init: RequestInit =
    body === undefined
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: parseBody(text) };
};

/** Polls until the actor's committed total equals `want`, or the wait runs out. */
const waitForTotal = async (
  port: number,
  key: string,
  want: number,
  timeoutMs: number,
): Promise<Reply> => {
  const deadline = Date.now() + timeoutMs;
  let last = await call(port, key, "/state");
  while (Date.now() < deadline) {
    if (totalOf(last) === want) {
      return last;
    }
    await sleep(200);
    last = await call(port, key, "/state");
  }
  return last;
};

/**
 * Polls the objects' databases on disk until the command carries a revision,
 * or the wait runs out. It sends no request, so it cannot wake an object.
 */
const waitForDisk = async (
  readObjects: NonNullable<typeof runtime.readObjects>,
  commandId: string,
  timeoutMs: number,
): Promise<ReadonlyArray<SqlRow>> => {
  const query = `SELECT c.command_id, c.revision, k.revision AS committed_revision,
                        k.state AS committed_state
                   FROM commands c LEFT JOIN committed k ON k.id = 1
                  WHERE c.command_id = '${commandId}'`;
  const deadline = Date.now() + timeoutMs;
  let rows = readObjects(proofDir, query);
  while (Date.now() < deadline) {
    if (rows.length > 0 && rows.every((row) => typeof row["revision"] === "number")) {
      return rows;
    }
    await sleep(200);
    rows = readObjects(proofDir, query);
  }
  return rows;
};

const totalOf = (reply: Reply): number => {
  const state = reply.body.state;
  if (typeof state === "object" && state !== null && "total" in state) {
    const total = (state as { total: unknown }).total;
    if (typeof total === "number") {
      return total;
    }
  }
  return Number.NaN;
};

const revisionOf = (reply: Reply): number => {
  const revision = reply.body.revision;
  return typeof revision === "number" ? revision : Number.NaN;
};

const pendingOf = (reply: Reply): ReadonlyArray<unknown> => {
  const pending = reply.body.pending;
  return Array.isArray(pending) ? pending : [];
};

const show = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * Row a — accepted, then killed.
 *
 * The send carries a long barrier, so the turn cannot finish before the kill.
 * After the restart, nothing asks the actor to do anything: the alarm the
 * admission transaction armed must drain the command on its own.
 */
const rowAcceptedThenKilled = async (node: Node): Promise<Node> => {
  const key = "row-a";
  const accepted = await call(node.port, key, "/send", {
    commandId: "a1",
    message: { amount: 7, delayMs: 5000 },
  });
  check(
    "a",
    "a send is accepted before the command is processed",
    accepted.status === 202 && accepted.body.admitted === 1,
    `status ${accepted.status}, body ${show(accepted.body)}`,
  );
  const beforeKill = await call(node.port, key, "/pending");
  check(
    "a",
    "the accepted command is still pending at the kill",
    pendingOf(beforeKill).length === 1,
    `pending ${show(beforeKill.body)}`,
  );

  await node.crash();
  const restarted = await runtime.start(proofDir, node.port);

  // Nothing here asks the actor to run. Only the armed alarm can drain it.
  // A runtime whose disk the proof can read shows that before any request
  // reaches the object; the request below would otherwise open it too.
  if (runtime.readObjects !== undefined) {
    const committed = await waitForDisk(runtime.readObjects, "a1", 20_000);
    check(
      "a",
      "with no request after the restart, the alarm commits the command exactly once",
      committed.length === 1 &&
        committed[0]?.["revision"] === 1 &&
        committed[0]?.["committed_revision"] === 1 &&
        committed[0]?.["committed_state"] === '{"total":7}',
      `rows on disk ${show(committed)}`,
    );
  }
  const state = await waitForTotal(restarted.port, key, 7, 20_000);
  const pending = await call(restarted.port, key, "/pending");
  check(
    "a",
    "after SIGKILL and restart the command applied once and the mailbox drained",
    totalOf(state) === 7 && pendingOf(pending).length === 0,
    `state ${show(state.body)}, pending ${show(pending.body)}`,
  );
  return restarted;
};

/**
 * Row b — committed, then retried.
 *
 * The retry after the crash must return the stored receipt, not run the
 * transition again.
 */
const rowCommittedThenRetry = async (node: Node): Promise<Node> => {
  const key = "row-b";
  const first = await call(node.port, key, "/call", {
    commandId: "c2",
    message: { amount: 5 },
    timeoutMs: 8000,
  });
  check(
    "b",
    "a call commits the command and returns the applied revision",
    first.status === 200 && totalOf(first) === 5 && revisionOf(first) === 1,
    `body ${show(first.body)}`,
  );

  await node.crash();
  const restarted = await runtime.start(proofDir, node.port);

  const retry = await call(restarted.port, key, "/call", {
    commandId: "c2",
    message: { amount: 5 },
    timeoutMs: 8000,
  });
  check(
    "b",
    "the retried command returns the stored receipt and does not apply twice",
    retry.status === 200 && totalOf(retry) === 5 && revisionOf(retry) === 1,
    `body ${show(retry.body)}`,
  );
  const state = await call(restarted.port, key, "/state");
  check(
    "b",
    "the committed state is unchanged after the retry",
    totalOf(state) === 5 && revisionOf(state) === 1,
    `state ${show(state.body)}`,
  );
  return restarted;
};

/** Row c — the same ID with a different payload is a conflict. */
const rowConflict = async (node: Node): Promise<void> => {
  const key = "row-b";
  const conflict = await call(node.port, key, "/send", {
    commandId: "c2",
    message: { amount: 99 },
  });
  check(
    "c",
    "the same command ID with a different payload is a CommandConflict",
    conflict.body.error === "CommandConflict",
    `status ${conflict.status}, body ${show(conflict.body)}`,
  );
  const state = await call(node.port, key, "/state");
  check(
    "c",
    "the rejected command did not change the state",
    totalOf(state) === 5,
    `state ${show(state.body)}`,
  );
};

/** Row d — three quick sends apply once each, in order. */
const rowOrdering = async (node: Node): Promise<void> => {
  const key = "row-d";
  const sends = await Promise.all([
    call(node.port, key, "/send", { commandId: "c3", message: { amount: 1 } }),
    call(node.port, key, "/send", { commandId: "c4", message: { amount: 2 } }),
    call(node.port, key, "/send", { commandId: "c5", message: { amount: 4 } }),
  ]);
  check(
    "d",
    "three quick sends are all accepted",
    sends.every((reply) => reply.status === 202),
    `statuses ${show(sends.map((reply) => reply.status))}`,
  );
  const state = await waitForTotal(node.port, key, 7, 15_000);
  const pending = await call(node.port, key, "/pending");
  check(
    "d",
    "all three commands applied once and the mailbox drained",
    totalOf(state) === 7 && revisionOf(state) === 3 && pendingOf(pending).length === 0,
    `state ${show(state.body)}, pending ${show(pending.body)}`,
  );
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
    node = await rowAcceptedThenKilled(node);
    node = await rowCommittedThenRetry(node);
    await rowConflict(node);
    await rowOrdering(node);
  } finally {
    await node.stop();
  }
  return report.print();
};

process.exitCode = await main();
