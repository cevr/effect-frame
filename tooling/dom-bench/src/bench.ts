/* oxlint-disable node/no-process-env, effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNewPromise, effect/noNodeBuiltinImport, effect/noNullish, effect/noRuntimeTypeof, effect/noTernary, effect/noThrowStatement, effect/noTryCatch -- this private CLI owns the Bun.WebView, Node child-process, filesystem, timer, JSON, and process-environment boundaries needed to run and bound browser cells. */

import { spawn } from "node:child_process";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import {
  apply,
  assertInvariant,
  adjectives,
  colors,
  initialState,
  nouns,
  type InvariantResult,
} from "./common.js";
import {
  cleanupProcessGroup,
  listenForProcessSignals,
  runProcess,
  type OwnedProcessState,
} from "./process.js";
import {
  EngineSchema,
  FrameworkSchema,
  OperationNameSchema,
  helpText,
  isInvalidOptionsError,
  officialBenchmarkIds,
  parseOptions,
} from "./options.js";
import type { EngineName, FrameworkName, OperationName } from "./options.js";
import {
  armCompletionExpression,
  awaitCompletionExpression,
  cancelCompletionExpression,
  completionStatsExpression,
  type CompletionStats,
} from "./completion.js";
import { bundleFixture, requireServedPageUrl, servePage } from "./page.js";
import { decodeChromeTraceEvents, reduceChromeTrace, traceCompletionMark } from "./trace.js";
import type { TraceReduction } from "./trace.js";

interface Operation {
  readonly name: OperationName;
  readonly label: string;
  readonly selector: string;
  readonly seed?: { readonly selector: string; readonly operation: OperationName };
}

interface MeasurementFailure {
  readonly engine: EngineName | "official";
  readonly framework: FrameworkName;
  readonly operation: string;
  readonly reason: string;
}

const InvariantSchema = Schema.Struct({
  ok: Schema.Boolean,
  rows: Schema.Finite,
  selected: Schema.Union([Schema.Finite, Schema.Null]),
  reason: Schema.optionalKey(Schema.String),
});

const MeasurementSchema = Schema.Struct({
  engine: EngineSchema,
  framework: FrameworkSchema,
  operation: OperationNameSchema,
  durationMs: Schema.Finite,
  invariant: InvariantSchema,
});

type Measurement = Schema.Schema.Type<typeof MeasurementSchema>;

const CellRequestSchema = Schema.Struct({
  framework: FrameworkSchema,
  engine: EngineSchema,
  operation: OperationNameSchema,
  chromePath: Schema.optionalKey(Schema.String),
  scriptPath: Schema.String,
});

type CellRequest = Schema.Schema.Type<typeof CellRequestSchema>;

const CellResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), measurement: MeasurementSchema }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
]);

type CellResult = Schema.Schema.Type<typeof CellResultSchema>;

const operations: ReadonlyArray<Operation> = [
  { name: "create-1k", label: "create 1k", selector: "#run" },
  {
    name: "replace-1k",
    label: "replace 1k",
    selector: "#run",
    seed: { selector: "#run", operation: "create-1k" },
  },
  {
    name: "update-10th-10k",
    label: "update 10th 10k",
    selector: "#update",
    seed: { selector: "#runlots", operation: "create-10k" },
  },
  {
    name: "select-1k",
    label: "select 1k",
    selector: "tbody>tr:nth-of-type(1)>td:nth-of-type(2)>a",
    seed: { selector: "#run", operation: "create-1k" },
  },
  {
    name: "swap-1k",
    label: "swap 1k",
    selector: "#swaprows",
    seed: { selector: "#run", operation: "create-1k" },
  },
  {
    name: "remove-1k",
    label: "remove 1k",
    selector: "tbody>tr:nth-of-type(1)>td:nth-of-type(3)>a>span",
    seed: { selector: "#run", operation: "create-1k" },
  },
  { name: "create-10k", label: "create 10k", selector: "#runlots" },
  {
    name: "append-10k",
    label: "append 1k to 10k",
    selector: "#add",
    seed: { selector: "#runlots", operation: "create-10k" },
  },
  {
    name: "clear-10k",
    label: "clear 10k",
    selector: "#clear",
    seed: { selector: "#runlots", operation: "create-10k" },
  },
];

const chromePathCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const krausestRevision = "f2df01a8679de05225c32714ca8cecbea3d78c5d";

type InterruptSignal = "SIGINT" | "SIGTERM";

let interruptedSignal: InterruptSignal | undefined;

const markInterrupted = (signal: InterruptSignal): void => {
  if (interruptedSignal !== undefined) return;
  interruptedSignal = signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
};

const wasInterrupted = (): boolean => interruptedSignal !== undefined;

const readGitRevision = async (root: string): Promise<string> => {
  const command = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const revision = (await new Response(command.stdout).text()).trim();
  const exitCode = await command.exited;
  if (exitCode !== 0 || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`cannot read krausest checkout revision at ${root}`);
  }
  return revision;
};

const timeout = async <A>(
  promise: Promise<A>,
  label: string,
  milliseconds = 15_000,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<A>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const findChromePath = async (): Promise<string | undefined> => {
  for (const candidate of chromePathCandidates) {
    // oxlint-disable-next-line no-await-in-loop -- browser candidates are probed in priority order.
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
};

const makeView = (engine: EngineName, chromePath: string | undefined): Bun.WebView => {
  if (engine === "webkit") {
    return new Bun.WebView({ backend: { type: "webkit", stderr: "ignore" } });
  }
  if (chromePath === undefined) {
    throw new Error("Chrome executable not found; pass --engine webkit or install Chrome");
  }
  return new Bun.WebView({
    backend: { type: "chrome", url: false, path: chromePath, stderr: "ignore" },
  });
};

const waitForReady = (view: Bun.WebView): Promise<void> =>
  timeout(
    view.evaluate<void>(
      "new Promise((resolve) => { const check = () => window.__benchReady ? resolve() : requestAnimationFrame(check); check(); })",
    ),
    "benchmark page startup",
  );

const version = (view: Bun.WebView): Promise<number> =>
  view.evaluate<number>("window.__benchVersion ?? 0");

const click = (view: Bun.WebView, selector: string): Promise<void> => view.click(selector);

interface PageVerification {
  readonly ok: boolean;
  readonly reason?: string;
}

const captureOperationState = (view: Bun.WebView): Promise<void> =>
  timeout(
    view.evaluate<void>(
      `(() => {
        const rows = document.querySelectorAll("tbody tr");
        window.__benchRowsBefore = Array.from(rows).map((row) => {
          const label = row.querySelector("td:nth-of-type(2)>a");
          return {
            id: Number(row.getAttribute("data-row-id")),
            label: label === null ? "" : label.textContent || "",
            selected: row.classList.contains("danger"),
            node: row.getAttribute("data-bench-node") || "",
          };
        });
        const positions = [0, 1, 998, 999, Math.floor(rows.length / 2), rows.length - 1];
        window.__benchIdentityBefore = new Map(positions
          .filter((position, index, all) => position >= 0 && position < rows.length && all.indexOf(position) === index)
          .map((position) => {
            const row = rows[position];
            return [Number(row.getAttribute("data-row-id")), row];
          }));
      })()`,
    ),
    "DOM node identity capture",
  );

const verifyNodeIdentity = (view: Bun.WebView): Promise<string | undefined> =>
  timeout(
    view.evaluate<string | undefined>(`(() => {
      const before = window.__benchIdentityBefore;
      if (!(before instanceof Map)) return "node identity snapshot is missing";
      for (const [id, node] of before) {
        const next = document.querySelector('tbody tr[data-row-id="' + id + '"]');
        if (next !== null && next !== node) return "row " + id + " received a different DOM node";
        if (next === null && document.contains(node)) return "removed row " + id + " remains in the DOM";
      }
      return undefined;
    })()`),
    "DOM node identity check",
  );

const verifyOperationInPage = (
  view: Bun.WebView,
  operation: OperationName,
): Promise<PageVerification> =>
  timeout(
    view.evaluate<PageVerification>(`(() => {
      const before = window.__benchRowsBefore || [];
      const after = Array.from(document.querySelectorAll("tbody tr")).map((row) => {
        const label = row.querySelector("td:nth-of-type(2)>a");
        return {
          id: Number(row.getAttribute("data-row-id")),
          label: label === null ? "" : label.textContent || "",
          selected: row.classList.contains("danger"),
          node: row.getAttribute("data-bench-node") || "",
        };
      });
      const adjectives = ${JSON.stringify(adjectives)};
      const colors = ${JSON.stringify(colors)};
      const nouns = ${JSON.stringify(nouns)};
      const canonical = (label) => {
        const base = label.endsWith(" !!!") ? label.slice(0, -4) : label;
        const words = base.split(" ");
        return words.length === 3 && adjectives.includes(words[0]) && colors.includes(words[1]) && nouns.includes(words[2]);
      };
      const same = (left, right) => left !== undefined && right !== undefined && left.id === right.id && left.label === right.label && left.selected === right.selected;
      const sameContent = (left, right) => left !== undefined && right !== undefined && left.id === right.id && left.label === right.label;
      const labelsMatch = (rows, firstId) => rows.every((row, index) => row.id === firstId + index && canonical(row.label) && !row.label.endsWith(" !!!"));
      const fail = (reason) => ({ ok: false, reason: ${JSON.stringify(operation)} + ": " + reason });
      switch (${JSON.stringify(operation)}) {
        case "create-1k":
          return after.length === 1000 && labelsMatch(after, 1) ? { ok: true } : fail("create-1k rows differ");
        case "replace-1k": {
          const last = before[before.length - 1];
          return last !== undefined && after.length === 1000 && labelsMatch(after, last.id + 1) ? { ok: true } : fail("replace-1k rows differ");
        }
        case "create-10k":
          return after.length === 10000 && labelsMatch(after, 1) ? { ok: true } : fail("create-10k rows differ");
        case "append-10k": {
          const last = before[before.length - 1];
          const appended = after.slice(before.length);
          return last !== undefined && after.length === 11000 && before.every((row, index) => same(row, after[index])) && labelsMatch(appended, last.id + 1)
            ? { ok: true }
            : fail("append rows differ");
        }
        case "update-10th-10k":
          return after.length === before.length && before.every((row, index) => {
            const next = after[index];
            return next !== undefined && next.id === row.id && canonical(next.label) && next.label === (index % 10 === 0 ? row.label + " !!!" : row.label) && next.node === row.node;
          }) ? { ok: true } : fail("update rows differ");
        case "select-1k":
          return after.length === before.length && before.every((row, index) => {
            const next = after[index];
            return sameContent(row, next) && next.node === row.node && next.selected === (row.id === 1);
          }) ? { ok: true } : fail("selection differs");
        case "swap-1k": {
          const expected = before.slice();
          const first = expected[1];
          const second = expected[998];
          if (first === undefined || second === undefined) return fail("swap source rows missing");
          expected[1] = second;
          expected[998] = first;
          return after.length === expected.length && expected.every((row, index) => same(row, after[index])) ? { ok: true } : fail("swap rows differ");
        }
        case "remove-1k":
          return after.length === before.length - 1 && before.filter((row) => row.id !== 1).every((row, index) => same(row, after[index])) ? { ok: true } : fail("remove rows differ");
        case "clear-10k":
          return after.length === 0 ? { ok: true } : fail("clear left rows");
      }
    })()`),
    "page operation verification",
  );

const armCompletion = (
  view: Bun.WebView,
  beforeVersion: number,
  rows: number,
  selected: number | null,
  operation: OperationName,
): Promise<void> =>
  timeout(
    view.evaluate<void>(armCompletionExpression({ beforeVersion, rows, selected, operation })),
    "benchmark completion setup",
  );

const awaitCompletion = async (view: Bun.WebView): Promise<InvariantResult> => {
  const result = await timeout(
    view.evaluate<InvariantResult>(awaitCompletionExpression),
    "benchmark operation completion",
  );
  if (!result.ok) throw new Error(result.reason ?? "benchmark operation completion failed");
  return result;
};

const readCompletionStats = (view: Bun.WebView): Promise<CompletionStats | undefined> =>
  timeout(
    view.evaluate<CompletionStats | undefined>(completionStatsExpression),
    "benchmark completion stats",
  );

/** Cancels the armed owner before the view closes. Closing the view stays the final boundary. */
const cancelCompletion = async (view: Bun.WebView): Promise<void> => {
  try {
    await timeout(
      view.evaluate<void>(cancelCompletionExpression),
      "benchmark completion cleanup",
      2_000,
    );
  } catch {
    // The page may already be closed or unresponsive; view.close() below still ends it.
  }
};

const readOperationDuration = (view: Bun.WebView): Promise<number> =>
  timeout(
    view.evaluate<number>("(window.__benchTiming?.end ?? 0) - (window.__benchTiming?.start ?? 0)"),
    "benchmark operation timing",
  );

/**
 * Controller-side stage log for one cell. Each stage records the controller's
 * wall time, which includes driver round trips and browser scheduling. Page
 * durations and completion counters are recorded separately from the page.
 */
type StageEntry =
  | { readonly stage: string; readonly controllerMs: number; readonly error?: string }
  | {
      readonly stage: string;
      readonly pageOperationMs: number;
      readonly completion: CompletionStats | undefined;
    }
  | ({ readonly stage: string; readonly tracePath: string } & TraceReduction)
  | ({ readonly stage: string } & InvariantResult);

interface StageLog {
  readonly entries: Array<StageEntry>;
  readonly run: <A>(stage: string, promise: () => Promise<A>) => Promise<A>;
  readonly note: (entry: StageEntry) => void;
}

const makeStageLog = (): StageLog => {
  const entries: Array<StageEntry> = [];
  return {
    entries,
    run: async (stage, promise) => {
      const started = performance.now();
      try {
        const value = await promise();
        entries.push({ stage, controllerMs: performance.now() - started });
        return value;
      } catch (error) {
        entries.push({
          stage,
          controllerMs: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    note: (entry) => {
      entries.push(entry);
    },
  };
};

const stageReceiptPath = Bun.env["DOM_BENCH_STAGE_RECEIPT"];

const recordStages = async (
  cell: {
    readonly engine: EngineName;
    readonly framework: FrameworkName;
    readonly operation: string;
  },
  stages: StageLog,
): Promise<void> => {
  if (stageReceiptPath === undefined || stageReceiptPath.length === 0) return;
  try {
    await appendFile(
      stageReceiptPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...cell, stages: stages.entries })}\n`,
    );
  } catch {
    // Stage receipts are diagnostic; the cell result remains the primary receipt.
  }
};

const finalInvariantExpression =
  Bun.env["DOM_BENCH_TEST_FALSE_INVARIANT"] === "1"
    ? // Test-only: proves that a false final invariant fails the cell with a receipt.
      "({ ok: false, rows: 0, selected: null, reason: 'test-forced false invariant' })"
    : "typeof window.__benchInvariant === 'function' ? window.__benchInvariant() : { ok: false, rows: 0, selected: null, reason: 'missing invariant' }";

const noteCompletion = async (view: Bun.WebView, stages: StageLog, operation: string) => {
  const completion = await stages.run(`${operation}: completion stats`, () =>
    readCompletionStats(view),
  );
  const pageOperationMs = await stages.run(`${operation}: page timing`, () =>
    readOperationDuration(view),
  );
  stages.note({ stage: `${operation}: page`, pageOperationMs, completion });
};

const measureChrome = async (
  view: Bun.WebView,
  selector: string,
  tracePath: string,
  stages: StageLog,
): Promise<number> => {
  const entries: Array<unknown> = [];
  let finish = (): void => {};
  const complete = new Promise<void>((resolveComplete) => {
    finish = resolveComplete;
  });
  view.addEventListener("Tracing.dataCollected", (event: Event) => {
    if (!("data" in event)) return;
    const data = event.data;
    if (typeof data !== "object" || data === null || !("value" in data)) return;
    if (Array.isArray(data.value)) entries.push(...data.value);
  });
  view.addEventListener("Tracing.tracingComplete", () => finish(), { once: true });
  await stages.run("trace start", () =>
    view.cdp("Tracing.start", {
      categories:
        "disabled-by-default-v8.cpu_profiler,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline",
      transferMode: "ReportEvents",
    }),
  );
  await stages.run("operation click", () => click(view, selector));
  await stages.run("operation completion", () => awaitCompletion(view));
  await stages.run("completion marker", () =>
    view.cdp("Tracing.recordClockSyncMarker", { syncId: traceCompletionMark }),
  );
  await stages.run("completed-DOM render frames", () =>
    timeout(
      view.evaluate<void>(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
      ),
      "Chrome completed-DOM render",
    ),
  );
  await stages.run("trace end", () => view.cdp("Tracing.end"));
  await stages.run("trace collection", () => timeout(complete, "Chrome trace completion"));
  const decodedEntries = decodeChromeTraceEvents(entries);
  await Bun.write(tracePath, JSON.stringify(decodedEntries));
  const reduced = reduceChromeTrace(decodedEntries);
  stages.note({ stage: "trace reduction", tracePath, ...reduced });
  return reduced.durationMs;
};

const seed = async (
  view: Bun.WebView,
  operation: Operation,
  stages: StageLog,
): Promise<OperationName | undefined> => {
  if (operation.seed === undefined) return undefined;
  const seedOperation = operation.seed.operation;
  const seedSelector = operation.seed.selector;
  const beforeVersion = await stages.run("seed version", () => version(view));
  const expected = apply(initialState, seedOperation);
  await stages.run("seed arm", () =>
    armCompletion(view, beforeVersion, expected.rows.length, expected.selected, seedOperation),
  );
  await stages.run("seed click", () => click(view, seedSelector));
  await stages.run("seed completion", () => awaitCompletion(view));
  await noteCompletion(view, stages, `seed ${seedOperation}`);
  return seedOperation;
};

const measure = async (
  framework: FrameworkName,
  engine: EngineName,
  script: string,
  chromePath: string | undefined,
  operation: Operation,
): Promise<Measurement> => {
  const stages = makeStageLog();
  const page = servePage(script);
  const view = makeView(engine, chromePath);
  try {
    await stages.run("navigate", () => view.navigate(requireServedPageUrl(page.url)));
    await stages.run("ready", () => waitForReady(view));
    const seeded = await seed(view, operation, stages);
    await stages.run("identity capture", () => captureOperationState(view));
    const before = seeded === undefined ? initialState : apply(initialState, seeded);
    const expected = apply(before, operation.name);
    const beforeVersion = await stages.run("operation version", () => version(view));
    await stages.run("operation arm", () =>
      armCompletion(view, beforeVersion, expected.rows.length, expected.selected, operation.name),
    );
    let durationMs: number;
    if (engine === "chrome") {
      const traceDirectory = Bun.env["DOM_BENCH_TRACE_DIR"] ?? "/tmp/effect-frame-dom-bench-traces";
      await mkdir(traceDirectory, { recursive: true });
      const tracePath = join(
        traceDirectory,
        `${framework}-${engine}-${operation.name}-${process.pid}.json`,
      );
      durationMs = await measureChrome(view, operation.selector, tracePath, stages);
    } else {
      await stages.run("operation click", () => click(view, operation.selector));
      await stages.run("operation completion", () => awaitCompletion(view));
      durationMs = await stages.run("operation timing", () => readOperationDuration(view));
    }
    await noteCompletion(view, stages, operation.name);
    const operationResult = await stages.run("full verification", () =>
      verifyOperationInPage(view, operation.name),
    );
    if (!operationResult.ok)
      throw new Error(operationResult.reason ?? `${operation.name}: page verification failed`);
    const identityError = await stages.run("identity check", () => verifyNodeIdentity(view));
    if (identityError !== undefined) throw new Error(`${operation.name}: ${identityError}`);
    const result = await stages.run("final invariant", () =>
      timeout(
        view.evaluate<InvariantResult>(finalInvariantExpression),
        "final benchmark invariant",
      ),
    );
    stages.note({ stage: "final invariant result", ...result });
    assertInvariant(operation.name, result);
    return { engine, framework, operation: operation.name, durationMs, invariant: result };
  } finally {
    await cancelCompletion(view);
    view.close();
    page.stop();
    await recordStages({ engine, framework, operation: operation.name }, stages);
  }
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const printMeasurements = (measurements: ReadonlyArray<Measurement>): void => {
  console.log("engine\tframework\toperation\tsamples\tmedian_ms\tmin_ms\tmax_ms\tstate");
  const groups = new Map<string, Array<Measurement>>();
  for (const measurement of measurements) {
    const key = `${measurement.engine}:${measurement.framework}:${measurement.operation}`;
    const group = groups.get(key) ?? [];
    group.push(measurement);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const values = group.map((item) => item.durationMs);
    const first = group[0];
    if (first === undefined) continue;
    console.log(
      [
        first.engine,
        first.framework,
        first.operation,
        values.length,
        median(values).toFixed(3),
        Math.min(...values).toFixed(3),
        Math.max(...values).toFixed(3),
        first.invariant.ok ? "ok" : "failed",
      ].join("\t"),
    );
  }
};

const configuredCellTimeoutMs = Number(Bun.env["DOM_BENCH_CELL_TIMEOUT_MS"] ?? 30_000);
const cellTimeoutMs =
  Number.isFinite(configuredCellTimeoutMs) && configuredCellTimeoutMs > 0
    ? Math.min(configuredCellTimeoutMs, 60_000)
    : 30_000;
const failureReceiptPath =
  Bun.env["DOM_BENCH_FAILURE_RECEIPT"] ?? "/tmp/effect-frame-dom-bench-failures.jsonl";

const recordFailure = async (failure: MeasurementFailure): Promise<void> => {
  try {
    await appendFile(
      failureReceiptPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...failure })}\n`,
    );
  } catch {
    // The table remains the primary CLI result when a receipt directory is unavailable.
  }
};

const runCellWorker = async (requestPath: string, resultPath: string): Promise<void> => {
  let result: CellResult;
  try {
    const request = Schema.decodeUnknownSync(CellRequestSchema)(
      JSON.parse(await Bun.file(requestPath).text()),
    );
    const operation = operations.find((candidate) => candidate.name === request.operation);
    if (operation === undefined)
      throw new Error(`unknown benchmark operation ${request.operation}`);
    const script = await Bun.file(request.scriptPath).text();
    result = {
      ok: true,
      measurement: await measure(
        request.framework,
        request.engine,
        script,
        request.chromePath,
        operation,
      ),
    };
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  await Bun.write(resultPath, JSON.stringify(result));
};

const runCellWithDeadline = async (request: CellRequest): Promise<Measurement> => {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestPath = `/tmp/effect-frame-dom-bench-cell-${token}.request.json`;
  const resultPath = `/tmp/effect-frame-dom-bench-cell-${token}.result.json`;
  await Bun.write(requestPath, JSON.stringify(request));

  let child: ReturnType<typeof spawn> | undefined;
  let childState: OwnedProcessState | undefined;
  let exitResolve: (value: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => void = () => {};
  let exitReject: (error: Error) => void = () => {};
  const exitedPromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    exitResolve = resolveExit;
    exitReject = rejectExit;
  });
  let rejectInterruption: (error: Error) => void = () => {};
  const interrupted = new Promise<Measurement>((_, reject) => {
    rejectInterruption = reject;
  });
  let removeSignals = (): void => {};
  try {
    removeSignals = listenForProcessSignals((signal) => {
      markInterrupted(signal);
      rejectInterruption(new Error(`benchmark cell interrupted by ${signal}`));
    });
    const testHoldMs = Number(Bun.env["DOM_BENCH_TEST_HOLD_BEFORE_CELL_MS"] ?? 0);
    if (Number.isFinite(testHoldMs) && testHoldMs > 0) {
      const readyPath = Bun.env["DOM_BENCH_TEST_SIGNAL_READY_FILE"];
      if (readyPath === undefined) {
        throw new Error("DOM_BENCH_TEST_HOLD_BEFORE_CELL_MS requires a signal-ready file");
      }
      await Bun.write(readyPath, "ready\n");
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          interrupted,
          new Promise<void>((resolveHold) => {
            holdTimer = setTimeout(resolveHold, Math.min(testHoldMs, 60_000));
          }),
        ]);
      } finally {
        if (holdTimer !== undefined) clearTimeout(holdTimer);
      }
      if (wasInterrupted()) throw new Error("benchmark cell interrupted before worker start");
    }
    child = spawn(process.execPath, [import.meta.filename], {
      env: {
        ...process.env,
        DOM_BENCH_CELL_REQUEST: requestPath,
        DOM_BENCH_CELL_RESULT: resultPath,
        DOM_BENCH_TEST_HOLD_BEFORE_CELL_MS: undefined,
        DOM_BENCH_TEST_SIGNAL_READY_FILE: undefined,
      },
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    childState = { spawned: child.pid !== undefined, exited: false };
    child.once("error", (error) => {
      exitReject(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      if (childState !== undefined) childState.exited = true;
      exitResolve({ code, signal });
    });
    const completed = exitedPromise.then(async ({ code, signal }) => {
      if (code !== 0)
        throw new Error(`benchmark cell exited with ${code ?? `signal ${signal ?? "unknown"}`}`);
      if (!(await Bun.file(resultPath).exists()))
        throw new Error("benchmark cell exited without a result receipt");
      const result = Schema.decodeUnknownSync(CellResultSchema)(
        JSON.parse(await Bun.file(resultPath).text()),
      );
      if (!result.ok) throw new Error(result.reason);
      return result.measurement;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completed,
        interrupted,
        new Promise<Measurement>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`benchmark cell timed out after ${cellTimeoutMs}ms`)),
            cellTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    removeSignals();
    if (child !== undefined) await cleanupProcessGroup(child, 1_000, childState);
    await rm(requestPath, { force: true });
    await rm(resultPath, { force: true });
  }
};

const stageOfficialFixture = async (
  root: string,
  framework: FrameworkName,
  script: string,
): Promise<string> => {
  const stagedName = `${framework}-effect-frame-local`;
  const staged = join(root, "frameworks", "keyed", stagedName);
  await mkdir(staged, { recursive: true });
  await Bun.write(
    join(staged, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${framework} local benchmark</title><link href="/css/currentStyle.css" rel="stylesheet"></head><body><div id="main"></div><script type="module" src="./fixture.js"></script></body></html>`,
  );
  await Bun.write(join(staged, "fixture.js"), script);
  await Bun.write(
    join(staged, "package.json"),
    JSON.stringify(
      {
        name: `js-framework-benchmark-${stagedName}`,
        version: "0.0.0",
        private: true,
        "js-framework-benchmark": {
          frameworkVersion: "0.0.0",
          frameworkHomeURL: "https://github.com/cevr/effect-frame",
          language: "TypeScript",
        },
      },
      null,
      2,
    ),
  );
  await Bun.write(
    join(staged, "package-lock.json"),
    JSON.stringify(
      {
        name: `js-framework-benchmark-${stagedName}`,
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: `js-framework-benchmark-${stagedName}`, version: "0.0.0" } },
      },
      null,
      2,
    ),
  );
  return stagedName;
};

interface OfficialServer {
  readonly process: ReturnType<typeof spawn> | undefined;
}

const startOfficialServer = async (
  root: string,
  port: number,
  interrupted: () => Error | undefined,
): Promise<OfficialServer> => {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  try {
    ready = (await fetch(`${base}/ls`)).ok;
  } catch {
    ready = false;
  }
  if (ready) return { process: undefined };
  const server = spawn("npm", ["start"], {
    cwd: join(root, "server"),
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const error = interrupted();
      if (error !== undefined) throw error;
      // oxlint-disable-next-line no-await-in-loop -- readiness polling is intentionally sequential.
      await Bun.sleep(100);
      try {
        // oxlint-disable-next-line no-await-in-loop -- each probe follows the previous bounded delay.
        ready = (await fetch(`${base}/ls`)).ok;
      } catch {
        ready = false;
      }
      if (ready) return { process: server };
    }
    throw new Error(`krausest server did not become ready at ${base}`);
  } catch (error) {
    await cleanupProcessGroup(server);
    throw error;
  }
};

const runOfficial = async (
  framework: FrameworkName,
  count: number,
  chromePath: string | undefined,
  script: string,
  operation?: OperationName,
): Promise<void> => {
  const root = Bun.env["KRAUSEST_DIR"];
  if (root === undefined || root.length === 0) {
    throw new Error("--official requires KRAUSEST_DIR pointing to the pinned krausest checkout");
  }
  const revision = await readGitRevision(root);
  if (revision !== krausestRevision) {
    throw new Error(
      `--official requires krausest revision ${krausestRevision}; found ${revision} at ${root}`,
    );
  }
  const runner = join(root, "webdriver-ts", "dist", "benchmarkRunner.js");
  if (!(await Bun.file(runner).exists())) {
    throw new Error(
      `krausest Playwright runner is missing: ${runner}; run npm ci and npm run compile in webdriver-ts`,
    );
  }
  const stagedName = await stageOfficialFixture(root, framework, script);

  const port = Number(Bun.env["KRAUSEST_PORT"] ?? Bun.env["PORT"] ?? 8080);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error("KRAUSEST_PORT must be a positive integer");
  let server: ReturnType<typeof spawn> | undefined;
  let interrupted: Error | undefined;
  const removeSignals = listenForProcessSignals((signal) => {
    markInterrupted(signal);
    interrupted = new Error(`official benchmark interrupted by ${signal}`);
  });
  try {
    const serverResult = await startOfficialServer(root, port, () => interrupted);
    server = serverResult.process;
    if (interrupted !== undefined) throw interrupted;
    const benchmarks = officialBenchmarkIds(operation);
    const args = [
      runner,
      "--runner",
      "playwright",
      "--framework",
      `keyed/${stagedName}`,
      "--benchmark",
      ...benchmarks,
      "--count",
      String(count),
      "--headless",
      "--nothrottling",
    ];
    if (chromePath !== undefined) args.push("--chromeBinary", chromePath);
    console.log(
      `official\tkrausest-playwright\t${framework}\t${benchmarks.join(",")}\t${revision}\t${root}`,
    );
    await runProcess(join(root, "webdriver-ts"), "node", args, {
      ...process.env,
      PORT: String(port),
    });
  } finally {
    removeSignals();
    if (server !== undefined) await cleanupProcessGroup(server);
  }
};

interface EngineRun {
  readonly measurements: ReadonlyArray<Measurement>;
  readonly failures: ReadonlyArray<MeasurementFailure>;
}

type CellRunResult =
  | { readonly outcome: "success"; readonly measurement: Measurement }
  | { readonly outcome: "failure"; readonly failure: MeasurementFailure };

const runOneCell = async (
  framework: FrameworkName,
  engine: EngineName,
  operation: OperationName,
  chromePath: string | undefined,
  scriptPath: string,
): Promise<CellRunResult> => {
  try {
    const measurement = await runCellWithDeadline({
      framework,
      engine,
      operation,
      chromePath,
      scriptPath,
    });
    return { outcome: "success", measurement };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      outcome: "failure",
      failure: { engine, framework, operation, reason },
    };
  }
};

const runEngine = async (
  framework: FrameworkName,
  engine: EngineName,
  count: number,
  only: OperationName | undefined,
  chromePath: string | undefined,
  scriptPath: string,
): Promise<EngineRun> => {
  const measurements: Array<Measurement> = [];
  const failures: Array<MeasurementFailure> = [];
  if (engine === "chrome" && chromePath === undefined) {
    failures.push({
      engine,
      framework,
      operation: "startup",
      reason: "Chrome executable not found",
    });
    return { measurements, failures };
  }
  const selectedOperations = operations.filter(
    (candidate) => only === undefined || candidate.name === only,
  );
  for (const operation of selectedOperations) {
    if (wasInterrupted()) break;
    for (let sample = 0; sample < count; sample += 1) {
      // oxlint-disable-next-line no-await-in-loop -- cells run serially to avoid cross-cell browser and CPU contention.
      const result = await runOneCell(framework, engine, operation.name, chromePath, scriptPath);
      if (result.outcome === "success") {
        measurements.push(result.measurement);
      } else {
        failures.push(result.failure);
        // oxlint-disable-next-line no-await-in-loop -- failure receipts preserve cell order.
        await recordFailure(result.failure);
      }
      if (wasInterrupted()) break;
    }
  }
  return { measurements, failures };
};

const main = async (): Promise<void> => {
  const options = parseOptions(Bun.argv.slice(2));
  if (options.help) {
    console.log(helpText);
    return;
  }
  const outputDirectory = resolve(import.meta.dir, "../.generated");
  const script = await bundleFixture(options.framework, outputDirectory);
  const scriptPath = join(outputDirectory, "fixture.js");
  const chromePath = options.engines.includes("chrome") ? await findChromePath() : undefined;
  const measurements: Array<Measurement> = [];
  const failures: Array<MeasurementFailure> = [];
  for (const engine of options.engines) {
    if (wasInterrupted()) break;
    // oxlint-disable-next-line no-await-in-loop -- engines run serially for comparable measurements.
    const result = await runEngine(
      options.framework,
      engine,
      options.count,
      options.only,
      chromePath,
      scriptPath,
    );
    measurements.push(...result.measurements);
    failures.push(...result.failures);
  }
  printMeasurements(measurements);
  if (failures.length > 0 && !wasInterrupted()) {
    console.log("engine\tframework\toperation\terror");
    for (const failure of failures) {
      console.log(
        [failure.engine, failure.framework, failure.operation, failure.reason].join("\t"),
      );
    }
    process.exitCode = 1;
  }
  if (options.official && !wasInterrupted()) {
    await runOfficial(options.framework, options.count, chromePath, script, options.only).catch(
      (error) => {
        if (wasInterrupted()) return;
        const reason = error instanceof Error ? error.message : String(error);
        console.log(["official", options.framework, "krausest-playwright", reason].join("\t"));
        process.exitCode = 1;
      },
    );
  }
};

const cellRequestPath = Bun.env["DOM_BENCH_CELL_REQUEST"];
const cellResultPath = Bun.env["DOM_BENCH_CELL_RESULT"];
if (import.meta.main) {
  if (cellRequestPath !== undefined && cellResultPath !== undefined) {
    await runCellWorker(cellRequestPath, cellResultPath);
  } else {
    await main().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      if (!wasInterrupted()) process.exitCode = isInvalidOptionsError(error) ? 2 : 1;
    });
  }
}
