/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNewPromise, effect/noNodeBuiltinImport, effect/noNullish, effect/noThrowStatement, effect/noTryCatch, no-await-in-loop, node/no-process-env -- this test drives the complete benchmark CLI and its child process. */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const benchmarkPath = resolve(packageRoot, "src/bench.ts");
const generatedPath = resolve(packageRoot, ".generated");

const waitForReady = async (path: string, child: ReturnType<typeof spawn>): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("benchmark CLI exited before the signal-ready receipt");
    }
    await Bun.sleep(25);
  }
  throw new Error("benchmark CLI did not write the signal-ready receipt");
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
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ready = `/tmp/effect-frame-dom-bench-cli-${token}.ready`;
    const receipt = `/tmp/effect-frame-dom-bench-cli-${token}.jsonl`;
    await rm(receipt, { force: true });
    await rm(ready, { force: true });
    const output: Array<string> = [];
    const child = spawn(
      process.execPath,
      [benchmarkPath, "--engine", "webkit", "--only", "create-1k", "--official"],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          KRAUSEST_DIR: "",
          DOM_BENCH_FAILURE_RECEIPT: receipt,
          DOM_BENCH_CELL_TIMEOUT_MS: "60000",
          DOM_BENCH_TEST_HOLD_BEFORE_CELL_MS: "10000",
          DOM_BENCH_TEST_SIGNAL_READY_FILE: ready,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));
    try {
      await waitForReady(ready, child);
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
      await rm(generatedPath, { recursive: true, force: true });
      await rm(ready, { force: true });
      await rm(receipt, { force: true });
    }
  }, 15_000);
});
