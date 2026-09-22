/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNodeBuiltinImport, effect/noNullish, effect/noThrowStatement, effect/noTryCatch, effect/noKnownValueWidening, no-await-in-loop, node/no-process-env -- these tests exercise the real owned process-group boundary. */

import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "../src/process.js";

const waitForFile = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(25);
  }
  throw new Error(`test child did not write ${path}`);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) return;
    await Bun.sleep(25);
  }
  throw new Error(`test descendant ${pid} is still alive`);
};

const startResistantGroup = (token: string) => {
  const pidPath = resolve("/tmp", `effect-frame-dom-bench-process-${token}.pid`);
  const childCode = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  return { pidPath, parentCode };
};

describe("owned benchmark process groups", () => {
  it("kills a TERM-resistant descendant after the leader exits on deadline", async () => {
    const { pidPath, parentCode } = startResistantGroup(`${process.pid}-deadline`);
    let descendantPid: number | undefined;
    try {
      const run = runProcess("/tmp", process.execPath, ["-e", parentCode], process.env, 500);
      await waitForFile(pidPath);
      descendantPid = Number(await Bun.file(pidPath).text());
      await expect(run).rejects.toThrow("timed out");
      await waitForExit(descendantPid);
    } finally {
      if (descendantPid !== undefined && isAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(pidPath, { force: true });
    }
  }, 5_000);

  it("cleans the owned group when the runner is interrupted", async () => {
    const { pidPath, parentCode } = startResistantGroup(`${process.pid}-interrupt`);
    let descendantPid: number | undefined;
    try {
      const run = runProcess("/tmp", process.execPath, ["-e", parentCode], process.env, 5_000);
      await waitForFile(pidPath);
      descendantPid = Number(await Bun.file(pidPath).text());
      process.emit("SIGINT");
      await expect(run).rejects.toThrow("interrupted by SIGINT");
      await waitForExit(descendantPid);
    } finally {
      if (descendantPid !== undefined && isAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(pidPath, { force: true });
    }
  }, 5_000);
});
