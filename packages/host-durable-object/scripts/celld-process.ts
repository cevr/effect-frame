/**
 * Process control for the celld proofs.
 *
 * Both proofs start the real celld binary, wait for its ready line, kill the
 * node child with SIGKILL, and start the same command again against the same
 * state directory. That is the only way to prove process loss with the local
 * disk retained. This file holds the parts both proofs share, so one fix
 * lands in both.
 *
 * This is a test runner, not library code. It uses plain promises and the
 * process APIs a runner needs.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";

const DEFAULT_CELLD_BIN = "/Users/cvr/Developer/personal/effect-frame/.tools/celld/bin/celld";

export const celldBin = process.env["CELLD_BIN"] ?? DEFAULT_CELLD_BIN;

export const freePort = (): Promise<number> =>
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

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export interface Node {
  readonly launcher: ChildProcess;
  readonly port: number;
  readonly logs: Array<string>;
}

/** Starts `celld dev` over the given directory and resolves on the ready line. */
export const start = async (projectDir: string, port: number): Promise<Node> => {
  const logs: Array<string> = [];
  const launcher = spawn(
    celldBin,
    ["dev", "--no-watch", "--logs", "--port", String(port), projectDir],
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
export const crash = async (node: Node): Promise<void> => {
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

export const stop = async (node: Node): Promise<void> => {
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
// Reporting
// ---------------------------------------------------------------------------

export interface Row {
  readonly id: string;
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Collects PASS/FAIL rows and prints the summary table the proof records. */
export interface Report {
  readonly check: (id: string, name: string, ok: boolean, detail: string) => void;
  /** Prints the table and returns the exit code: 0 when every row passed. */
  readonly print: () => number;
}

export const makeReport = (): Report => {
  const rows: Array<Row> = [];
  const check = (id: string, name: string, passed: boolean, detail: string): void => {
    rows.push({ id, name, passed, detail });
    const mark = passed ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${id}. ${name}${passed ? "" : ` — ${detail}`}`);
  };
  const print = (): number => {
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
  return { check, print } satisfies Report;
};
