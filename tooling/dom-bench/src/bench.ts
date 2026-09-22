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
  parseOptions,
} from "./options.js";
import type { EngineName, FrameworkName, OperationName } from "./options.js";
import { decodeChromeTraceEvents, reduceChromeTrace, traceCompletionMark } from "./trace.js";

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

const frameworkEntries = {
  "effect-frame": "./fixtures/effect-frame.tsx",
  solid2: "./fixtures/solid2.ts",
  octane: "./fixtures/octane.ts",
} satisfies Readonly<Record<FrameworkName, string>>;

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

const bundle = async (framework: FrameworkName): Promise<string> => {
  const outputDirectory = resolve(import.meta.dir, "../.generated");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const entrypoint = resolve(import.meta.dir, frameworkEntries[framework]);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    minify: false,
    conditions: framework === "effect-frame" ? ["browser", "source"] : ["browser"],
    naming: "fixture.js",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`no browser bundle produced for ${framework}`);
  return output.text();
};

const pageUrl = (script: string): string => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>effect-frame DOM benchmark</title></head><body><main id="main"></main><script type="module">${script}</script></body></html>`;
  return `data:text/html,${encodeURIComponent(html)}`;
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
    view.evaluate<void>(`(() => {
      if (typeof window.__benchCompletionCancel === "function") window.__benchCompletionCancel();
      window.__benchTiming = { start: 0, end: 0 };
      const selectedValue = ${selected === null ? "null" : selected};
      const operation = ${JSON.stringify(operation)};
      const adjectives = ${JSON.stringify(adjectives)};
      const colors = ${JSON.stringify(colors)};
      const nouns = ${JSON.stringify(nouns)};
      const canonical = (label) => {
        const base = label.endsWith(" !!!") ? label.slice(0, -4) : label;
        const words = base.split(" ");
        return words.length === 3 && adjectives.includes(words[0]) && colors.includes(words[1]) && nouns.includes(words[2]);
      };
      const operationRowsMatch = () => {
        const rows = Array.from(document.querySelectorAll("tbody tr"));
        if (rows.length !== ${rows}) return false;
        for (const [index, row] of rows.entries()) {
          const id = Number(row.getAttribute("data-row-id"));
          const label = row.querySelector("td:nth-of-type(2)>a");
          const text = label === null ? "" : label.textContent || "";
          const expectedId = operation === "replace-1k" ? 1001 + index
            : operation === "swap-1k" && index === 1 ? 999
            : operation === "swap-1k" && index === 998 ? 2
            : operation === "remove-1k" ? 2 + index
            : 1 + index;
          if (id !== expectedId || !canonical(text)) return false;
          const changed = text.endsWith(" !!!");
          const expectedChanged = operation === "update-10th-10k" && index % 10 === 0;
          if (changed !== expectedChanged) return false;
        }
        return true;
      };
      const target = document.querySelector("tbody") || document;
      const clickTarget = document;
      window.__benchCompletion = new Promise((resolve) => {
        let finished = false;
        const check = () => {
          const rowCount = document.querySelectorAll("tbody tr").length;
          const selectedRows = document.querySelectorAll("tbody tr.danger").length;
          const selectedRow = document.querySelector("tbody tr.danger");
          const selectedId = selectedRow === null ? undefined : selectedRow.getAttribute("data-row-id");
          const selectedMatches = selectedValue === null
            ? selectedRows === 0
            : selectedRows === 1 && Number(selectedId) === selectedValue;
          const rowsMatch = operation === "clear-10k" ? rowCount === 0 : operationRowsMatch();
          if (!finished && (window.__benchVersion || 0) > ${beforeVersion} && rowsMatch && selectedMatches) {
            finished = true;
            observer.disconnect();
            window.__benchTiming.end = performance.now();
            resolve({ ok: true, rows: rowCount, selected: selectedValue });
          }
        };
        const observer = new MutationObserver(() => check());
        window.__benchCommit = check;
        const onClick = () => {
          window.__benchTiming.start = performance.now();
          clickTarget.removeEventListener("click", onClick, true);
        };
        clickTarget.addEventListener("click", onClick, true);
        observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
        window.__benchCompletionCancel = () => {
          observer.disconnect();
          clickTarget.removeEventListener("click", onClick, true);
          window.__benchCommit = undefined;
        };
      });
    })()`),
    "benchmark completion setup",
  );

const awaitCompletion = (view: Bun.WebView): Promise<InvariantResult> =>
  timeout(
    view.evaluate<InvariantResult>("window.__benchCompletion"),
    "benchmark operation completion",
  );

const readOperationDuration = (view: Bun.WebView): Promise<number> =>
  timeout(
    view.evaluate<number>("(window.__benchTiming?.end ?? 0) - (window.__benchTiming?.start ?? 0)"),
    "benchmark operation timing",
  );

const measureChrome = async (
  view: Bun.WebView,
  selector: string,
  tracePath: string,
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
  await view.cdp("Tracing.start", {
    categories:
      "disabled-by-default-v8.cpu_profiler,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  await click(view, selector);
  await awaitCompletion(view);
  await view.cdp("Tracing.recordClockSyncMarker", { syncId: traceCompletionMark });
  await timeout(
    view.evaluate<void>(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
    ),
    "Chrome completed-DOM render",
  );
  await view.cdp("Tracing.end");
  await timeout(complete, "Chrome trace completion");
  const decodedEntries = decodeChromeTraceEvents(entries);
  await Bun.write(tracePath, JSON.stringify(decodedEntries));
  return reduceChromeTrace(decodedEntries).durationMs;
};

const seed = async (
  view: Bun.WebView,
  operation: Operation,
): Promise<OperationName | undefined> => {
  if (operation.seed === undefined) return undefined;
  const beforeVersion = await version(view);
  const expected = apply(initialState, operation.seed.operation);
  await armCompletion(
    view,
    beforeVersion,
    expected.rows.length,
    expected.selected,
    operation.seed.operation,
  );
  await click(view, operation.seed.selector);
  await awaitCompletion(view);
  return operation.seed.operation;
};

const measure = async (
  framework: FrameworkName,
  engine: EngineName,
  script: string,
  chromePath: string | undefined,
  operation: Operation,
): Promise<Measurement> => {
  const view = makeView(engine, chromePath);
  try {
    await view.navigate(pageUrl(script));
    await waitForReady(view);
    const seeded = await seed(view, operation);
    await captureOperationState(view);
    const before = seeded === undefined ? initialState : apply(initialState, seeded);
    const expected = apply(before, operation.name);
    const beforeVersion = await version(view);
    await armCompletion(
      view,
      beforeVersion,
      expected.rows.length,
      expected.selected,
      operation.name,
    );
    let durationMs: number;
    if (engine === "chrome") {
      const traceDirectory = Bun.env["DOM_BENCH_TRACE_DIR"] ?? "/tmp/effect-frame-dom-bench-traces";
      await mkdir(traceDirectory, { recursive: true });
      const tracePath = join(
        traceDirectory,
        `${framework}-${engine}-${operation.name}-${process.pid}.json`,
      );
      durationMs = await measureChrome(view, operation.selector, tracePath);
    } else {
      await click(view, operation.selector);
      await awaitCompletion(view);
      durationMs = await readOperationDuration(view);
    }
    const operationResult = await verifyOperationInPage(view, operation.name);
    if (!operationResult.ok)
      throw new Error(operationResult.reason ?? `${operation.name}: page verification failed`);
    const identityError = await verifyNodeIdentity(view);
    if (identityError !== undefined) throw new Error(`${operation.name}: ${identityError}`);
    const result = await timeout(
      view.evaluate<InvariantResult>(
        "typeof window.__benchInvariant === 'function' ? window.__benchInvariant() : { ok: false, rows: 0, selected: null, reason: 'missing invariant' }",
      ),
      "final benchmark invariant",
    );
    assertInvariant(operation.name, result);
    return { engine, framework, operation: operation.name, durationMs, invariant: result };
  } finally {
    view.close();
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
    child = spawn(process.execPath, [import.meta.filename], {
      env: {
        ...process.env,
        DOM_BENCH_CELL_REQUEST: requestPath,
        DOM_BENCH_CELL_RESULT: resultPath,
      },
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    childState = { spawned: child.pid !== undefined, spawnFailed: false, exited: false };
    removeSignals = listenForProcessSignals((signal) => {
      markInterrupted(signal);
      rejectInterruption(new Error(`benchmark cell interrupted by ${signal}`));
    });
    child.once("error", (error) => {
      if (childState !== undefined) childState.spawnFailed = true;
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

const officialBenchmarkId = (operation: OperationName | undefined): string => {
  switch (operation) {
    case "create-1k":
      return "01_";
    case "replace-1k":
      return "02_";
    case "update-10th-10k":
      return "03_";
    case "select-1k":
      return "04_";
    case "swap-1k":
      return "05_";
    case "remove-1k":
      return "06_";
    case "create-10k":
      return "07_";
    case "append-10k":
      return "08_";
    case "clear-10k":
      return "09_";
    default:
      return "03_";
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
    const args = [
      runner,
      "--runner",
      "playwright",
      "--framework",
      `keyed/${stagedName}`,
      "--benchmark",
      officialBenchmarkId(operation),
      "--count",
      String(count),
      "--headless",
      "--nothrottling",
    ];
    if (chromePath !== undefined) args.push("--chromeBinary", chromePath);
    console.log(
      `official\tkrausest-playwright\t${framework}\t${officialBenchmarkId(operation)}\t${revision}\t${root}`,
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
  const script = await bundle(options.framework);
  const scriptPath = resolve(import.meta.dir, "../.generated/fixture.js");
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
