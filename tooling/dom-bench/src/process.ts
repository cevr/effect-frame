/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNewPromise, effect/noNodeBuiltinImport, effect/noNullish, effect/noTernary, effect/noTryCatch, no-await-in-loop, node/no-process-env -- this private CLI owns bounded child-process groups and signal cleanup. */

import { spawn } from "node:child_process";

export type OwnedProcess = ReturnType<typeof spawn>;

export interface OwnedProcessState {
  spawned: boolean;
  exited: boolean;
}

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

const hasExited = (child: OwnedProcess, state?: OwnedProcessState): boolean =>
  state?.exited === true || child.exitCode !== null || child.signalCode !== null;

const waitForExit = (
  child: OwnedProcess,
  milliseconds: number,
  state?: OwnedProcessState,
): Promise<boolean> => {
  if (hasExited(child, state)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (exited && state !== undefined) state.exited = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const onError = (): void => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once("exit", onExit);
    child.once("error", onError);
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
  state?: OwnedProcessState,
): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (!hasExited(child, state)) sendSignal(child, "SIGTERM");
    if (!(await waitForExit(child, graceMilliseconds, state)) && !hasExited(child, state)) {
      sendSignal(child, "SIGKILL");
      if (!(await waitForExit(child, graceMilliseconds, state))) {
        // oxlint-disable-next-line effect/noNewError, effect/noThrowStatement -- a surviving owned process is a bounded cleanup failure.
        throw new Error(`owned process ${pid} did not exit after SIGKILL`);
      }
    }
    return;
  }
  if (groupExists(pid)) sendSignal(child, "SIGTERM");
  await waitForExit(child, graceMilliseconds, state);
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
    const state: OwnedProcessState = {
      spawned: child.pid !== undefined,
      exited: false,
    };
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
      const cleanup = state.spawned ? cleanupProcessGroup(child, 1_000, state) : Promise.resolve();
      void cleanup.then(finish, rejectProcess);
    };
    const settleFailure = (error: Error): void => {
      settle(() => rejectProcess(error));
    };
    child.once("error", (error) => {
      settleFailure(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      state.exited = true;
      if (code === 0) {
        settle(resolveProcess);
        return;
      }
      settleFailure(new Error(`${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
