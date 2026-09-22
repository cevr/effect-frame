/* oxlint-disable effect/noGlobals, effect/noNullish, effect/noTernary -- this module builds page-side JavaScript source: JSON.stringify embeds literals, and the page describes nullable browser values such as "no selected row". */

import { adjectives, colors, nouns } from "./common.js";
import type { OperationName } from "./common.js";

/**
 * Page-side completion controller for one benchmark operation.
 *
 * One armed operation has one owner. The owner is terminal after success or
 * cancellation. A terminal owner, or an owner whose operation has not started,
 * rejects every notification before it reads the DOM. Observer and manual
 * notifications share one pending check. The pending check is a zero-delay
 * timer task, so it reads the DOM after the task and microtasks that produced
 * the notification, without waiting for a rendering opportunity. It verifies
 * the owner again when it runs. Success, cancellation, replacement by a new
 * owner, and page hide all clear the pending timer.
 */
export interface CompletionRequest {
  readonly beforeVersion: number;
  readonly rows: number;
  readonly selected: number | null;
  readonly operation: OperationName;
}

/** Counters kept by one completion owner, read by tests and stage receipts. */
export interface CompletionStats {
  readonly id: number;
  readonly state: "armed" | "resolved" | "cancelled";
  readonly observerNotifications: number;
  readonly manualNotifications: number;
  readonly scheduled: number;
  readonly checks: number;
  readonly rejectedTerminal: number;
  readonly rejectedPreOperation: number;
  readonly checkMs: number;
  readonly maxCheckMs: number;
}

const canonicalLabelSource = `
      const adjectives = ${JSON.stringify(adjectives)};
      const colors = ${JSON.stringify(colors)};
      const nouns = ${JSON.stringify(nouns)};
      const canonical = (label) => {
        const base = label.endsWith(" !!!") ? label.slice(0, -4) : label;
        const words = base.split(" ");
        return words.length === 3 && adjectives.includes(words[0]) && colors.includes(words[1]) && nouns.includes(words[2]);
      };`;

/**
 * Builds the expression that arms one completion owner. Arming replaces and
 * cancels the current owner. `window.__benchCompletion` resolves with
 * `{ ok: true }` on success and `{ ok: false }` on cancellation.
 */
export const armCompletionExpression = (request: CompletionRequest): string => `(() => {
      const scope = window.__benchCompletionScope || (window.__benchCompletionScope = { nextId: 0, current: undefined });
      if (scope.current !== undefined) scope.current.cancel("replaced by a new operation");
      const beforeVersion = ${request.beforeVersion};
      const expectedRows = ${request.rows};
      const selectedValue = ${request.selected === null ? "null" : request.selected};
      const operation = ${JSON.stringify(request.operation)};
      ${canonicalLabelSource}
      const operationRowsMatch = () => {
        const rows = Array.from(document.querySelectorAll("tbody tr"));
        if (rows.length !== expectedRows) return false;
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
      const domMatches = () => {
        const rowCount = document.querySelectorAll("tbody tr").length;
        const selectedRows = document.querySelectorAll("tbody tr.danger").length;
        const selectedRow = document.querySelector("tbody tr.danger");
        const selectedId = selectedRow === null ? undefined : selectedRow.getAttribute("data-row-id");
        const selectedMatches = selectedValue === null
          ? selectedRows === 0
          : selectedRows === 1 && Number(selectedId) === selectedValue;
        if (!selectedMatches) return undefined;
        const rowsMatch = operation === "clear-10k" ? rowCount === 0 : operationRowsMatch();
        return rowsMatch ? rowCount : undefined;
      };
      const timing = { start: 0, end: 0 };
      window.__benchTiming = timing;
      const stats = {
        id: scope.nextId + 1,
        state: "armed",
        observerNotifications: 0,
        manualNotifications: 0,
        scheduled: 0,
        checks: 0,
        rejectedTerminal: 0,
        rejectedPreOperation: 0,
        checkMs: 0,
        maxCheckMs: 0,
      };
      scope.nextId = stats.id;
      scope.last = stats;
      let settle = () => {};
      window.__benchCompletion = new Promise((resolve) => {
        settle = resolve;
      });
      let pending;
      const unschedule = () => {
        if (pending === undefined) return;
        clearTimeout(pending);
        pending = undefined;
      };
      const target = document.querySelector("tbody") || document;
      let onClick = () => {};
      let onPageHide = () => {};
      let observer;
      const commit = () => owner.notify("manual");
      const finish = (state) => {
        if (stats.state !== "armed") return false;
        stats.state = state;
        unschedule();
        if (observer !== undefined) observer.disconnect();
        document.removeEventListener("click", onClick, true);
        window.removeEventListener("pagehide", onPageHide);
        if (window.__benchCommit === commit) window.__benchCommit = undefined;
        if (scope.current === owner) scope.current = undefined;
        return true;
      };
      const run = () => {
        pending = undefined;
        if (stats.state !== "armed") {
          stats.rejectedTerminal += 1;
          return;
        }
        if (timing.start === 0 || (window.__benchVersion || 0) <= beforeVersion) {
          stats.rejectedPreOperation += 1;
          return;
        }
        stats.checks += 1;
        const started = performance.now();
        const rowCount = domMatches();
        const elapsed = performance.now() - started;
        stats.checkMs += elapsed;
        if (elapsed > stats.maxCheckMs) stats.maxCheckMs = elapsed;
        if (rowCount === undefined) return;
        timing.end = performance.now();
        if (finish("resolved")) settle({ ok: true, rows: rowCount, selected: selectedValue });
      };
      const owner = {
        stats,
        notify: (source) => {
          if (stats.state !== "armed") {
            stats.rejectedTerminal += 1;
            return;
          }
          if (source === "manual") stats.manualNotifications += 1;
          else stats.observerNotifications += 1;
          if (pending !== undefined) return;
          stats.scheduled += 1;
          pending = setTimeout(run, 0);
        },
        cancel: (reason) => {
          if (finish("cancelled")) {
            settle({ ok: false, rows: 0, selected: selectedValue, reason: "completion cancelled: " + reason });
          }
        },
      };
      onClick = () => {
        if (stats.state !== "armed" || timing.start !== 0) return;
        timing.start = performance.now();
        document.removeEventListener("click", onClick, true);
      };
      onPageHide = () => owner.cancel("page closed");
      observer = new MutationObserver(() => owner.notify("observer"));
      scope.current = owner;
      window.__benchCommit = commit;
      document.addEventListener("click", onClick, true);
      window.addEventListener("pagehide", onPageHide);
      observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
    })()`;

/** Resolves with the current owner's completion result. */
export const awaitCompletionExpression = "window.__benchCompletion";

/** Cancels the current owner, if one is armed. */
export const cancelCompletionExpression = `(() => {
      const scope = window.__benchCompletionScope;
      if (scope !== undefined && scope.current !== undefined) scope.current.cancel("cell cleanup");
    })()`;

/** Reads the counters of the most recently armed owner. */
export const completionStatsExpression = `(() => {
      const scope = window.__benchCompletionScope;
      return scope === undefined ? undefined : scope.last;
    })()`;
