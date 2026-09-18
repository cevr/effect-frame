/**
 * The celld recovery proof.
 *
 * It runs the real celld 0.5.0 binary against an isolated copy of the fixture,
 * kills the node with SIGKILL between phases, restarts the same command, and
 * asserts what must survive. Nothing here runs in CI: it needs the binary and
 * takes about half a minute. Run it with `bun run proof:celld`.
 *
 * This file is a test runner, not library code. It uses plain promises and the
 * process APIs a runner needs.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

const DEFAULT_CELLD_BIN = "/Users/cvr/Developer/personal/effect-frame/.tools/celld/bin/celld";
const celldBin = process.env["CELLD_BIN"] ?? DEFAULT_CELLD_BIN;

const proofDir = join(repoRoot, ".proof", "celld");
const fixtureSource = join(packageRoot, "fixture");

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  readonly name: string;
  passed: boolean;
  detail: string;
}

const rows: Array<Row> = [];

const record = (id: string, name: string, passed: boolean, detail: string): void => {
  rows.push({ id, name, passed, detail });
  const mark = passed ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${id}. ${name}${passed ? "" : ` — ${detail}`}`);
};

const check = (id: string, name: string, ok: boolean, detail: string): void => {
  record(id, name, ok, detail);
};

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

const freePort = (): Promise<number> =>
  new Promise((done, failed) => {
    const server = createServer();
    server.on("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        failed(new Error("no port"));
        return;
      }
      const port = address.port;
      server.close(() => done(port));
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface Node {
  readonly launcher: ChildProcess;
  readonly port: number;
  readonly logs: Array<string>;
}

/** Starts `celld dev` and resolves once the ready line appears. */
const start = async (port: number): Promise<Node> => {
  const logs: Array<string> = [];
  const launcher = spawn(
    celldBin,
    ["dev", "--no-watch", "--logs", "--port", String(port), proofDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (chunk: Buffer): void => {
    logs.push(chunk.toString());
  };
  launcher.stdout?.on("data", collect);
  launcher.stderr?.on("data", collect);

  const ready = `ready  http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (logs.join("").includes(ready)) {
      // Give the node a beat after the ready line before the first request.
      await sleep(300);
      return { launcher, port, logs };
    }
    if (launcher.exitCode !== null) {
      throw new Error(`celld dev exited early:\n${logs.join("")}`);
    }
    await sleep(100);
  }
  throw new Error(`celld dev never became ready:\n${logs.join("")}`);
};

/** The one node child the launcher spawned. */
const nodeChild = (launcherPid: number): number => {
  const out = execFileSync("pgrep", ["-P", String(launcherPid)], { encoding: "utf8" });
  const pids = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid));
  const first = pids[0];
  if (first === undefined) {
    throw new Error(`launcher ${launcherPid} has no child`);
  }
  return first;
};

const exited = (child: ChildProcess): Promise<void> =>
  new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.on("exit", () => done());
  });

/**
 * Kills the node with SIGKILL, the way a machine loses a process. The launcher
 * then exits with an error and does not restart, so the caller starts the same
 * command again against the same state directory.
 */
const crash = async (node: Node): Promise<void> => {
  const launcherPid = node.launcher.pid;
  if (launcherPid === undefined) {
    throw new Error("launcher has no pid");
  }
  const child = nodeChild(launcherPid);
  process.kill(child, "SIGKILL");
  await Promise.race([exited(node.launcher), sleep(8000)]);
  if (node.launcher.exitCode === null && node.launcher.signalCode === null) {
    node.launcher.kill("SIGKILL");
    await Promise.race([exited(node.launcher), sleep(3000)]);
  }
  // Let the port free up before the restart binds it again.
  await sleep(500);
};

const stop = async (node: Node): Promise<void> => {
  const launcherPid = node.launcher.pid;
  if (launcherPid !== undefined) {
    try {
      process.kill(nodeChild(launcherPid), "SIGKILL");
    } catch {
      // The child may already be gone.
    }
  }
  node.launcher.kill("SIGKILL");
  await Promise.race([exited(node.launcher), sleep(3000)]);
};

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

const prepare = (): void => {
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  cpSync(join(fixtureSource, "worker.js"), join(proofDir, "worker.js"));
  cpSync(join(fixtureSource, "wrangler.jsonc"), join(proofDir, "wrangler.jsonc"));
};

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

  await crash(node);
  const restarted = await start(node.port);

  // Nothing here asks the actor to run. Only the armed alarm can drain it.
  const state = await waitForTotal(restarted.port, key, 7, 20_000);
  const pending = await call(restarted.port, key, "/pending");
  check(
    "a",
    "after SIGKILL and restart the alarm drains the command with no request",
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

  await crash(node);
  const restarted = await start(node.port);

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
  console.log(`celld binary: ${celldBin}`);
  console.log(`proof dir:    ${proofDir}`);
  console.log("");
  prepare();

  const port = await freePort();
  let node = await start(port);
  try {
    console.log("rows:");
    node = await rowAcceptedThenKilled(node);
    node = await rowCommittedThenRetry(node);
    await rowConflict(node);
    await rowOrdering(node);
  } finally {
    await stop(node);
  }

  console.log("");
  console.log(
    "| row | check                                                            | result |",
  );
  console.log(
    "| --- | ---------------------------------------------------------------- | ------ |",
  );
  for (const row of rows) {
    const name = row.name.padEnd(64).slice(0, 64);
    console.log(`| ${row.id}   | ${name} | ${row.passed ? "PASS  " : "FAIL  "} |`);
  }
  const failed = rows.filter((row) => !row.passed);
  console.log("");
  if (failed.length > 0) {
    console.log(`${failed.length} of ${rows.length} checks FAILED:`);
    for (const row of failed) {
      console.log(`  ${row.id}. ${row.name} — ${row.detail}`);
    }
    return 1;
  }
  console.log(`all ${rows.length} checks passed`);
  return 0;
};

process.exitCode = await main();
