/**
 * What every recovery proof shares, whichever runtime serves the fixture.
 *
 * A proof copies a built fixture into an isolated project directory, starts a
 * runtime over it, kills that runtime with SIGKILL between phases, and starts
 * it again over the same directory, so the disk survives and the process does
 * not. A `Runtime` is the one place that knows how to start and kill one
 * runtime; the proofs never name a binary.
 *
 * This is a test runner, not library code. It uses plain promises and the
 * process APIs a runner needs.
 */

import type { ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { SqlRow } from "../src/storage.js";

/** One running runtime over one project directory. */
export interface Node {
  readonly port: number;
  readonly logs: Array<string>;
  /** Kills the serving process with SIGKILL, the way a machine loses it. */
  readonly crash: () => Promise<void>;
  /** Stops the runtime at the end of a proof. */
  readonly stop: () => Promise<void>;
}

/** A local runtime that serves a Durable Object fixture. */
export interface Runtime {
  readonly name: string;
  /** What the proof prints as the runtime it ran against. */
  readonly describe: string;
  /** Starts the runtime over the directory and resolves once it serves. */
  readonly start: (projectDir: string, port: number) => Promise<Node>;
  /**
   * Runs a read-only query against every object's database on disk, without
   * a request to any object. A proof uses it to show that the alarm, and not
   * a client, committed a command. Absent when the runtime's disk layout is
   * not known.
   */
  readonly readObjects?: (projectDir: string, query: string) => ReadonlyArray<SqlRow>;
}

/** Ports this machine keeps for other work. A proof never binds them. */
const reserved = new Set([3102, 3187]);

const anyPort = (): Promise<number> =>
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

export const freePort = async (): Promise<number> => {
  const port = await anyPort();
  return reserved.has(port) ? freePort() : port;
};

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Resolves once the child has exited, or at once if it already has. */
export const exited = (child: ChildProcess): Promise<void> =>
  new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.on("exit", () => done());
  });

/** Copies a built fixture (`worker.js` + `wrangler.jsonc`) into a clean directory. */
export const prepare = (fixtureDir: string, proofDir: string): void => {
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  cpSync(join(fixtureDir, "worker.js"), join(proofDir, "worker.js"));
  cpSync(join(fixtureDir, "wrangler.jsonc"), join(proofDir, "wrangler.jsonc"));
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
