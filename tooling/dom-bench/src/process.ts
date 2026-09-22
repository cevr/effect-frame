/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNewPromise, effect/noNodeBuiltinImport, effect/noNullish, effect/noTernary, effect/noTryCatch, no-await-in-loop, node/no-process-env -- this private CLI owns bounded child-process groups and signal cleanup. */

import { spawn } from "node:child_process";

export type OwnedProcess = ReturnType<typeof spawn>;

type ProcessSignal = "SIGINT" | "SIGTERM";

const interruptSignals: ReadonlyArray<ProcessSignal> = ["SIGINT", "SIGTERM"];

const groupExists = (pid: number): boolean => {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    return false;
  }
};

const sendSignal = (child: OwnedProcess, signal: NodeJS.Signals): void => {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group can disappear between the liveness check and the signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The direct child can disappear before its group is reaped.
  }
};

const waitForExit = (child: OwnedProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => resolve();
    child.once("exit", done);
    child.once("error", done);
  });
};

const waitForGroupGone = async (pid: number, milliseconds: number): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (groupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await Bun.sleep(Math.min(25, remaining));
  }
  return true;
};

export const cleanupProcessGroup = async (
  child: OwnedProcess,
  graceMilliseconds = 1_000,
): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined || process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) sendSignal(child, "SIGTERM");
    await Promise.race([waitForExit(child), Bun.sleep(graceMilliseconds)]);
    if (child.exitCode === null && child.signalCode === null) sendSignal(child, "SIGKILL");
    await waitForExit(child);
    return;
  }
  if (groupExists(pid)) sendSignal(child, "SIGTERM");
  await Promise.race([waitForExit(child), Bun.sleep(graceMilliseconds)]);
  if (groupExists(pid)) sendSignal(child, "SIGKILL");
  if (!(await waitForGroupGone(pid, graceMilliseconds))) {
    sendSignal(child, "SIGKILL");
    if (!(await waitForGroupGone(pid, graceMilliseconds))) {
      // oxlint-disable-next-line effect/noNewError, effect/noThrowStatement -- a surviving owned group is a cleanup failure that must fail the bounded operation.
      throw new Error(`owned process group ${pid} did not exit after SIGKILL`);
    }
  }
};

export const listenForProcessSignals = (handler: (signal: ProcessSignal) => void): (() => void) => {
  const listeners = new Map<ProcessSignal, () => void>();
  for (const signal of interruptSignals) {
    const listener = (): void => handler(signal);
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  };
};

export const runProcess = (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  milliseconds = 60_000,
): Promise<void> =>
  new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let settled = false;
    const timer = setTimeout(() => {
      settleFailure(new Error(`${command} timed out after ${milliseconds}ms`));
    }, milliseconds);
    const removeSignals = listenForProcessSignals((signal) => {
      settleFailure(new Error(`${command} interrupted by ${signal}`));
    });
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeSignals();
      void cleanupProcessGroup(child).then(finish, rejectProcess);
    };
    const settleFailure = (error: Error): void => {
      settle(() => rejectProcess(error));
    };
    child.once("error", (error) => {
      settleFailure(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        settle(resolveProcess);
        return;
      }
      settleFailure(new Error(`${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
