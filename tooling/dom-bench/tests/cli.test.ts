/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNewPromise, effect/noNodeBuiltinImport, effect/noNullish, effect/noThrowStatement, effect/noTryCatch, no-await-in-loop, node/no-process-env -- this test drives the complete benchmark CLI and its child process. */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const benchmarkPath = resolve(packageRoot, "src/bench.ts");
const requestPrefix = "effect-frame-dom-bench-cell-";

const requestNames = async (): Promise<ReadonlyArray<string>> => {
  const names = await readdir("/tmp");
  return names.filter((name) => name.startsWith(requestPrefix) && name.endsWith(".request.json"));
};

const waitForNewRequest = async (before: ReadonlyArray<string>): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const names = await requestNames();
    const request = names.find((name) => !before.includes(name));
    if (request !== undefined) return request;
    await Bun.sleep(25);
  }
  throw new Error("benchmark CLI did not start a cell worker");
};

interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const waitForExit = (child: ReturnType<typeof spawn>): Promise<ExitResult> =>
  new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

describe("benchmark CLI interruption", () => {
  it("preserves SIGINT and skips the official runner", async () => {
    const before = await requestNames();
    const receipt = `/tmp/effect-frame-dom-bench-cli-${process.pid}.jsonl`;
    await rm(receipt, { force: true });
    const output: Array<string> = [];
    const child = spawn(
      process.execPath,
      [benchmarkPath, "--engine", "webkit", "--only", "update-10th-10k", "--official"],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          KRAUSEST_DIR: "",
          DOM_BENCH_FAILURE_RECEIPT: receipt,
          DOM_BENCH_CELL_TIMEOUT_MS: "60000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));
    let request: string | undefined;
    try {
      request = await waitForNewRequest(before);
      await Bun.sleep(100);
      if (child.pid === undefined) throw new Error("benchmark CLI child has no pid");
      process.kill(child.pid, "SIGINT");
      const exit = await Promise.race([
        waitForExit(child),
        Bun.sleep(10_000).then(() => undefined),
      ]);
      if (exit === undefined) throw new Error("benchmark CLI did not exit after SIGINT");
      expect(exit.code).toBe(130);
      expect(output.join("")).not.toContain("krausest-playwright");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (request !== undefined) await rm(resolve("/tmp", request), { force: true });
      await rm(receipt, { force: true });
    }
  }, 15_000);
});
