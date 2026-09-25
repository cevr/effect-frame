/**
 * The celld runtime for the recovery proofs.
 *
 * It starts the real celld binary with `celld dev` over a project directory,
 * waits for its ready line, and kills the node child with SIGKILL. The
 * launcher then exits and does not restart, so a proof starts the same
 * command again against the same state directory. celld keeps that state at
 * `<projectDir>/.celld/dev`.
 *
 * This is a test runner, not library code. It uses plain promises and the
 * process APIs a runner needs.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import type { Node, Runtime } from "./proof.js";
import { exited, sleep } from "./proof.js";

const DEFAULT_CELLD_BIN = "/Users/cvr/Developer/personal/effect-frame/.tools/celld/bin/celld";

export const celldBin = process.env["CELLD_BIN"] ?? DEFAULT_CELLD_BIN;

/** The one node child the launcher spawned. */
const nodeChild = (launcherPid: number): number => {
  const out = execFileSync("pgrep", ["-P", String(launcherPid)], { encoding: "utf8" });
  const first = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number.parseInt(line, 10))
    .find((pid) => Number.isInteger(pid));
  if (first === undefined) {
    throw new Error(`launcher ${launcherPid} has no child`);
  }
  return first;
};

/**
 * Kills the node with SIGKILL, the way a machine loses a process. The launcher
 * then exits with an error and does not restart.
 */
const crash = async (launcher: ChildProcess): Promise<void> => {
  const launcherPid = launcher.pid;
  if (launcherPid === undefined) {
    throw new Error("launcher has no pid");
  }
  const child = nodeChild(launcherPid);
  process.kill(child, "SIGKILL");
  await Promise.race([exited(launcher), sleep(8000)]);
  if (launcher.exitCode === null && launcher.signalCode === null) {
    launcher.kill("SIGKILL");
    await Promise.race([exited(launcher), sleep(3000)]);
  }
  // Let the port free up before the restart binds it again.
  await sleep(500);
};

const stop = async (launcher: ChildProcess): Promise<void> => {
  const launcherPid = launcher.pid;
  if (launcherPid !== undefined) {
    try {
      process.kill(nodeChild(launcherPid), "SIGKILL");
    } catch {
      // The child may already be gone.
    }
  }
  launcher.kill("SIGKILL");
  await Promise.race([exited(launcher), sleep(3000)]);
};

/** Starts `celld dev` over the given directory and resolves on the ready line. */
const start = async (projectDir: string, port: number): Promise<Node> => {
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
      return {
        port,
        logs,
        crash: () => crash(launcher),
        stop: () => stop(launcher),
      } satisfies Node;
    }
    if (launcher.exitCode !== null) {
      throw new Error(`celld dev exited early:\n${logs.join("")}`);
    }
    await sleep(100);
  }
  throw new Error(`celld dev never became ready:\n${logs.join("")}`);
};

export const celld: Runtime = {
  name: "celld",
  describe: `celld binary ${celldBin}`,
  start,
};
