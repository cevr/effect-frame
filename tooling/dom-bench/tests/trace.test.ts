import { describe, expect, it } from "bun:test";
import { apply, initialState, labelFor, makeRows } from "../src/common.js";
import {
  decodeChromeTraceEvents,
  reduceChromeTrace,
  traceCompletionMark,
  type ChromeTraceEvent,
} from "../src/trace.js";

describe("krausest trace reduction", () => {
  it("decodes untrusted trace entries before reduction", () => {
    expect(() => decodeChromeTraceEvents([{ ts: "not-a-number" }])).toThrow();
  });

  it("reduces one native click to the next same-process Commit", () => {
    const events: ReadonlyArray<ChromeTraceEvent> = [
      {
        name: "EventDispatch",
        ph: "X",
        ts: 100_000,
        dur: 5_000,
        pid: 1,
        args: { data: { type: "click" } },
      },
      { name: "FunctionCall", ph: "X", ts: 110_000, dur: 10_000, pid: 1 },
      { name: "clock_sync", ph: "c", ts: 121_000, pid: 99, args: { sync_id: traceCompletionMark } },
      { name: "Commit", ph: "X", ts: 125_000, dur: 5_000, pid: 1 },
    ];
    const result = reduceChromeTrace(events);
    expect(result.durationMs).toBe(30);
    expect(result.commits).toBe(1);
    expect(result.droppedOtherProcessCommitEvents).toBe(false);
    expect(result.droppedOtherProcessEvents).toBe(false);
  });

  it("keeps the main process and records discarded renderer commits", () => {
    const events: ReadonlyArray<ChromeTraceEvent> = [
      {
        name: "EventDispatch",
        ph: "X",
        ts: 100_000,
        dur: 5_000,
        pid: 1,
        args: { data: { type: "click" } },
      },
      { name: "Commit", ph: "X", ts: 120_000, dur: 5_000, pid: 2 },
      { name: traceCompletionMark, ph: "R", ts: 121_000, pid: 1 },
      { name: "Commit", ph: "X", ts: 125_000, dur: 5_000, pid: 1 },
    ];
    const result = reduceChromeTrace(events);
    expect(result.durationMs).toBe(30);
    expect(result.commits).toBe(1);
    expect(result.droppedOtherProcessCommitEvents).toBe(true);
    expect(result.droppedOtherProcessEvents).toBe(true);
  });

  it("does not extend the click-to-Commit window with later host callbacks", () => {
    const events: ReadonlyArray<ChromeTraceEvent> = [
      {
        name: "EventDispatch",
        ph: "X",
        ts: 100_000,
        dur: 5_000,
        pid: 1,
        args: { data: { type: "click" } },
      },
      { name: "FunctionCall", ph: "X", ts: 110_000, dur: 10_000, pid: 1 },
      { name: traceCompletionMark, ph: "R", ts: 121_000, pid: 1 },
      { name: "Commit", ph: "X", ts: 125_000, dur: 5_000, pid: 1 },
      { name: "FunctionCall", ph: "X", ts: 200_000, dur: 50_000, pid: 1 },
    ];
    expect(reduceChromeTrace(events).durationMs).toBe(30);
  });

  it("rejects an early Commit when completed DOM work has no later Commit", () => {
    const events: ReadonlyArray<ChromeTraceEvent> = [
      {
        name: "EventDispatch",
        ph: "X",
        ts: 100_000,
        dur: 1_000,
        pid: 1,
        args: { data: { type: "click" } },
      },
      { name: "Commit", ph: "X", ts: 105_000, dur: 1_000, pid: 1 },
      { name: traceCompletionMark, ph: "R", ts: 110_000, pid: 1 },
      { name: "FunctionCall", ph: "X", ts: 111_000, dur: 70_000, pid: 1 },
    ];
    expect(() => reduceChromeTrace(events)).toThrow("no Commit event after completed DOM");
  });

  it("rejects the upstream inconsistent animation-frame case", () => {
    const events: ReadonlyArray<ChromeTraceEvent> = [
      {
        name: "EventDispatch",
        ph: "X",
        ts: 100_000,
        dur: 5_000,
        pid: 1,
        args: { data: { type: "click" } },
      },
      { name: "RequestAnimationFrame", ts: 101_000, pid: 1 },
      { name: "RequestAnimationFrame", ts: 102_000, pid: 1 },
      { name: traceCompletionMark, ph: "R", ts: 110_000, pid: 1 },
      { name: "FireAnimationFrame", ph: "X", ts: 111_000, dur: 1_000, pid: 1 },
      { name: "Commit", ph: "X", ts: 120_000, dur: 1_000, pid: 1 },
    ];
    expect(() => reduceChromeTrace(events)).toThrow("one FireAnimationFrame");
  });

  it("applies keyed operation state with the benchmark's expected row counts", () => {
    const oneThousand = apply(initialState, "create-1k");
    expect(oneThousand.rows).toHaveLength(1_000);
    expect(apply(oneThousand, "swap-1k").rows[1]?.id).toBe(999);
    expect(apply(oneThousand, "remove-1k").rows).toHaveLength(999);
    const tenThousand = apply(initialState, "create-10k");
    expect(apply(tenThousand, "append-10k").rows).toHaveLength(11_000);
    expect(apply(tenThousand, "clear-10k").rows).toHaveLength(0);
    expect(apply(tenThousand, "update-10th-10k").rows[0]?.label).toBe(`${labelFor(0)} !!!`);
    expect(apply(tenThousand, "update-10th-10k").rows[9]?.label).toBe(labelFor(9));
    expect(makeRows(1_000)[0]?.id).toBe(1);
  });
});
