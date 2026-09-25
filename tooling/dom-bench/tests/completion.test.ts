/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNewPromise, effect/noNodeBuiltinImport, effect/noNullish, effect/noTernary, effect/noTestLifecycleHooks, effect/noThrowStatement, effect/noTryCatch -- these tests drive a real Bun.WebView page with the real 10,000-row fixture. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armCompletionExpression,
  awaitCompletionExpression,
  completionStatsExpression,
  type CompletionStats,
} from "../src/completion.js";
import { bundleFixture, servePage, type ServedPage } from "../src/page.js";
import type { InvariantResult } from "../src/common.js";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Engine = "webkit" | "chrome";

const engines: Array<Engine> = [];
if (process.platform === "darwin") engines.push("webkit");
if (await Bun.file(chromePath).exists()) engines.push("chrome");

const within = async <A>(label: string, promise: Promise<A>, milliseconds = 15_000): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<A>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const makeView = (engine: Engine): Bun.WebView =>
  engine === "webkit"
    ? new Bun.WebView({ backend: { type: "webkit", stderr: "ignore" } })
    : new Bun.WebView({
        backend: { type: "chrome", url: false, path: chromePath, stderr: "ignore" },
      });

const tenThousand = { rows: 10_000, selected: null };

describe.skipIf(engines.length === 0)("benchmark completion owner", () => {
  let directory = "";
  let page: ServedPage | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "effect-frame-dom-bench-completion-"));
    page = servePage(await bundleFixture("effect-frame", directory));
  });

  afterAll(async () => {
    page?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  for (const engine of engines) {
    describe(engine, () => {
      const withPage = async (body: (view: Bun.WebView) => Promise<void>): Promise<void> => {
        if (page === undefined) throw new Error("fixture page is not served");
        const view = makeView(engine);
        try {
          await within("navigate", view.navigate(page.url));
          await within(
            "ready",
            view.evaluate(
              "new Promise((resolve) => { const check = () => window.__benchReady ? resolve() : requestAnimationFrame(check); check(); })",
            ),
          );
          await body(view);
        } finally {
          view.close();
        }
      };

      const evaluate = <A>(view: Bun.WebView, expression: string): Promise<A> =>
        within("page evaluation", view.evaluate<A>(expression));

      const arm = async (
        view: Bun.WebView,
        operation: "create-10k" | "update-10th-10k",
      ): Promise<void> => {
        const beforeVersion = await evaluate<number>(view, "window.__benchVersion ?? 0");
        await evaluate(view, armCompletionExpression({ beforeVersion, operation, ...tenThousand }));
      };

      const stats = (view: Bun.WebView): Promise<CompletionStats> =>
        evaluate<CompletionStats>(view, completionStatsExpression);

      const heldStats = (view: Bun.WebView): Promise<CompletionStats> =>
        evaluate<CompletionStats>(view, "window.__heldOwner.stats");

      const holdOwner = (view: Bun.WebView): Promise<void> =>
        evaluate(
          view,
          "(() => { window.__heldOwner = window.__benchCompletionScope.current; window.__heldCommit = window.__benchCommit; })()",
        );

      const seed = async (view: Bun.WebView): Promise<void> => {
        await arm(view, "create-10k");
        await holdOwner(view);
        await within("seed click", view.click("#runlots"));
        const result = await evaluate<InvariantResult>(view, awaitCompletionExpression);
        expect(result.ok).toBe(true);
      };

      it("keeps a retained callback inert after the owner finishes", async () => {
        await withPage(async (view) => {
          await seed(view);
          const finished = await heldStats(view);
          expect(finished.state).toBe("resolved");
          expect(await evaluate<boolean>(view, "window.__benchCommit === undefined")).toBe(true);
          await evaluate(
            view,
            "(() => { for (let index = 0; index < 5; index += 1) window.__heldCommit(); })()",
          );
          await evaluate(view, "new Promise((resolve) => setTimeout(resolve, 50))");
          const after = await heldStats(view);
          expect(after.rejectedTerminal).toBe(finished.rejectedTerminal + 5);
          expect(after.scheduled).toBe(finished.scheduled);
          expect(after.checks).toBe(finished.checks);

          await arm(view, "update-10th-10k");
          await evaluate(view, "window.__heldCommit()");
          await within("update click", view.click("#update"));
          const result = await evaluate<InvariantResult>(view, awaitCompletionExpression);
          expect(result.ok).toBe(true);
          const next = await stats(view);
          expect(next.id).toBe(finished.id + 1);
          expect(next.state).toBe("resolved");
          expect((await heldStats(view)).checks).toBe(finished.checks);
        });
      }, 60_000);

      it("keeps a cancelled owner inert when queued callbacks run later", async () => {
        await withPage(async (view) => {
          await arm(view, "create-10k");
          await holdOwner(view);
          // Keep the queued timer alive through cancellation, so the queued check
          // itself must reject the terminal owner when it runs.
          const result = await evaluate<InvariantResult>(
            view,
            `(() => {
              const clear = window.clearTimeout;
              window.clearTimeout = () => {};
              try {
                window.__heldCommit();
                window.__heldOwner.cancel("test cancellation");
              } finally {
                window.clearTimeout = clear;
              }
              return window.__benchCompletion;
            })()`,
          );
          expect(result.ok).toBe(false);
          expect(result.reason).toContain("test cancellation");
          await within("click after cancel", view.click("#runlots"));
          await evaluate(view, "window.__heldCommit()");
          await evaluate(view, "new Promise((resolve) => setTimeout(resolve, 100))");
          const cancelled = await heldStats(view);
          expect(cancelled.state).toBe("cancelled");
          expect(cancelled.checks).toBe(0);
          expect(cancelled.scheduled).toBe(1);
          expect(cancelled.rejectedTerminal).toBe(2);
          expect(cancelled.observerNotifications).toBe(0);
          expect(await evaluate<boolean>(view, "window.__benchCommit === undefined")).toBe(true);
          expect(await evaluate<number>(view, "window.__benchTiming.start")).toBe(0);
        });
      }, 60_000);

      it("keeps a new owner working after the old owner is cancelled again", async () => {
        await withPage(async (view) => {
          await arm(view, "create-10k");
          await holdOwner(view);
          await arm(view, "create-10k");
          const replaced = await heldStats(view);
          expect(replaced.state).toBe("cancelled");
          await evaluate(
            view,
            "(() => { window.__heldOwner.cancel('late cancellation'); window.__heldCommit(); })()",
          );
          expect(
            await evaluate<boolean>(
              view,
              "window.__benchCommit !== undefined && window.__benchCommit !== window.__heldCommit && window.__benchCompletionScope.current !== window.__heldOwner",
            ),
          ).toBe(true);
          await within("click", view.click("#runlots"));
          const result = await evaluate<InvariantResult>(view, awaitCompletionExpression);
          expect(result).toEqual({ ok: true, rows: 10_000, selected: null });
          const current = await stats(view);
          expect(current.id).toBe(replaced.id + 1);
          expect(current.state).toBe("resolved");
          expect((await heldStats(view)).checks).toBe(0);
        });
      }, 60_000);

      it("groups a mutation burst into one pending check and waits for complete content", async () => {
        await withPage(async (view) => {
          await seed(view);
          // The fixture can keep writing row attributes after the rows are complete.
          // Wait for a quiet tbody so the counts below belong to this test's burst.
          await evaluate(
            view,
            `new Promise((resolve) => {
              let timer = setTimeout(done, 250);
              const observer = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(done, 250);
              });
              function done() {
                observer.disconnect();
                resolve();
              }
              observer.observe(document.querySelector("tbody"), { subtree: true, childList: true, characterData: true, attributes: true });
            })`,
          );
          await arm(view, "update-10th-10k");
          // Start the operation without the fixture's own update: a trusted click on
          // a non-operation element records the start, and the version advances.
          await within("start click", view.click("h1"));
          const partial = await evaluate<CompletionStats>(
            view,
            `(async () => {
              window.__benchVersion += 1;
              const links = Array.from(document.querySelectorAll("tbody tr td:nth-of-type(2)>a"));
              for (let index = 0; index < 5000; index += 10) links[index].textContent += " !!!";
              await new Promise((resolve) => setTimeout(resolve, 100));
              return { ...window.__benchCompletionScope.last };
            })()`,
          );
          expect(partial.state).toBe("armed");
          expect(partial.observerNotifications).toBe(1);
          expect(partial.scheduled).toBe(1);
          expect(partial.checks).toBe(1);

          const burst = await evaluate<CompletionStats>(
            view,
            `(async () => {
              const links = Array.from(document.querySelectorAll("tbody tr td:nth-of-type(2)>a"));
              for (let index = 5000; index < 10000; index += 10) {
                links[index].textContent += " !!!";
                window.__benchCommit();
              }
              return { ...window.__benchCompletionScope.last };
            })()`,
          );
          expect(burst.manualNotifications).toBe(500);
          expect(burst.scheduled).toBe(partial.scheduled + 1);
          const result = await evaluate<InvariantResult>(view, awaitCompletionExpression);
          expect(result).toEqual({ ok: true, rows: 10_000, selected: null });
          const done = await stats(view);
          expect(done.state).toBe("resolved");
          expect(done.scheduled).toBe(2);
          expect(done.checks).toBe(2);
        });
      }, 60_000);
    });
  }
});
