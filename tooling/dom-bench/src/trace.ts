/* oxlint-disable effect/noNewError, effect/noNullish, effect/noRuntimeTypeof, effect/noTernary, effect/noThrowStatement, effect/noUnknownParameters -- this reducer mirrors the official trace parser and reports malformed external trace data as a bounded CLI failure. */

import { Schema } from "effect";

export const traceCompletionMark = "effect-frame-dom-bench-complete";

const ChromeTraceEventSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  ph: Schema.optionalKey(Schema.String),
  ts: Schema.optionalKey(Schema.Finite),
  dur: Schema.optionalKey(Schema.Finite),
  pid: Schema.optionalKey(Schema.Finite),
  args: Schema.optionalKey(Schema.Unknown),
});

const ChromeTraceEventsSchema = Schema.Array(ChromeTraceEventSchema);

export type ChromeTraceEvent = Schema.Schema.Type<typeof ChromeTraceEventSchema>;

export const decodeChromeTraceEvents = (
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<ChromeTraceEvent> => Schema.decodeUnknownSync(ChromeTraceEventsSchema)(entries);

interface TimingEvent {
  readonly type: string;
  readonly ts: number;
  readonly dur: number;
  readonly end: number;
  readonly pid: number;
}

export interface TraceReduction {
  readonly durationMs: number;
  readonly commits: number;
  readonly layouts: number;
  readonly maxDeltaBetweenCommitsMs: number;
  readonly rafLongDelayMs: number;
  readonly droppedOtherProcessCommitEvents: boolean;
  readonly droppedOtherProcessEvents: boolean;
}

const numberOrZero = (value: number | undefined): number => value ?? 0;

const makeTimingEvent = (type: string, ts: number, dur: number, pid: number): TimingEvent => ({
  type,
  ts,
  dur,
  end: ts + dur,
  pid,
});

const xEvent = (
  entry: ChromeTraceEvent,
  ts: number,
  dur: number,
  pid: number,
): TimingEvent | undefined => {
  if (entry.ph !== "X") return undefined;
  switch (entry.name) {
    case "Layout":
      return makeTimingEvent("layout", ts, dur, pid);
    case "FunctionCall":
      return makeTimingEvent("functioncall", ts, dur, pid);
    case "HitTest":
      return makeTimingEvent("hittest", ts, dur, pid);
    case "Commit":
      return makeTimingEvent("commit", ts, dur, pid);
    case "Paint":
      return makeTimingEvent("paint", ts, dur, pid);
    case "FireAnimationFrame":
      return makeTimingEvent("fireAnimationFrame", ts, dur, pid);
    case "TimerFire":
      return makeTimingEvent("timerFire", ts, 0, pid);
    default:
      return undefined;
  }
};

const eventData = (args: unknown): object | undefined => {
  if (typeof args !== "object" || args === null || !("data" in args)) return undefined;
  const data = args.data;
  return typeof data === "object" && data !== null ? data : undefined;
};

const eventType = (args: unknown): string | undefined => {
  const data = eventData(args);
  if (data === undefined || !("type" in data)) return undefined;
  const type = data.type;
  return typeof type === "string" ? type : undefined;
};

const eventMessage = (args: unknown): string | undefined => {
  const data = eventData(args);
  if (data === undefined || !("message" in data)) return undefined;
  const message = data.message;
  return typeof message === "string" ? message : undefined;
};

const eventSyncId = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null || !("sync_id" in args)) return undefined;
  const syncId = args.sync_id;
  return typeof syncId === "string" ? syncId : undefined;
};

const toTimingEvent = (entry: ChromeTraceEvent): TimingEvent | undefined => {
  const ts = numberOrZero(entry.ts);
  const dur = numberOrZero(entry.dur);
  const pid = numberOrZero(entry.pid);
  if (entry.name === traceCompletionMark) {
    return makeTimingEvent("completion", ts, 0, pid);
  }
  if (entry.name === "TimeStamp" && eventMessage(entry.args) === traceCompletionMark) {
    return makeTimingEvent("completion", ts, 0, pid);
  }
  if (entry.name === "clock_sync" && eventSyncId(entry.args) === traceCompletionMark) {
    return makeTimingEvent("completion", ts, 0, pid);
  }
  if (entry.name === "EventDispatch") {
    const type = eventType(entry.args);
    if (type === "click" || type === "mousedown" || type === "pointerup") {
      return makeTimingEvent(type, ts, dur, pid);
    }
    return undefined;
  }
  if (entry.name === "RequestAnimationFrame") {
    return makeTimingEvent("requestAnimationFrame", ts, 0, pid);
  }
  return xEvent(entry, ts, dur, pid);
};

const relevantEvents = (entries: ReadonlyArray<ChromeTraceEvent>): Array<TimingEvent> => {
  const events: Array<TimingEvent> = [];
  for (const entry of entries) {
    const event = toTimingEvent(entry);
    if (event !== undefined) events.push(event);
  }
  return events;
};

/**
 * Reduce the Chrome trace with the click-to-Commit rule from krausest and an
 * explicit mark for the completed DOM state.
 * Trace timestamps and durations are in microseconds; the result is ms.
 */
export const reduceChromeTrace = (
  entries: ReadonlyArray<ChromeTraceEvent>,
  startLogicEvent = "click",
): TraceReduction => {
  const decodedEntries = decodeChromeTraceEvents(entries);
  const events = relevantEvents(decodedEntries).sort((left, right) => left.end - right.end);
  const clicks = events.filter((event) => event.type === startLogicEvent);
  if (clicks.length !== 1) {
    throw new Error(`expected one ${startLogicEvent} event, found ${clicks.length}`);
  }
  const click = clicks[0];
  if (click === undefined) {
    throw new Error(`missing ${startLogicEvent} event`);
  }
  const during = events.filter((event) => event.ts > click.end || event.type === "click");
  const measured = during.filter((event) => event.type !== "completion");
  const main = measured.filter((event) => event.pid === click.pid);
  const dropped = main.length !== measured.length;
  const commits = main.filter((event) => event.type === "commit");
  if (commits.length === 0) {
    throw new Error("no Commit event after click");
  }
  const completion = events.find((event) => event.type === "completion" && event.ts > click.end);
  if (completion === undefined) {
    throw new Error(`missing ${traceCompletionMark} trace mark`);
  }
  const commit = commits.find((event) => event.ts > completion.end);
  if (commit === undefined) {
    throw new Error("no Commit event after completed DOM");
  }
  const rafs = events.filter(
    (event) =>
      event.type === "requestAnimationFrame" && event.ts >= click.ts && event.ts <= click.end,
  );
  const frames = events.filter(
    (event) => event.type === "fireAnimationFrame" && event.ts >= click.ts && event.ts < commit.ts,
  );
  const layouts = main.filter((event) => event.type === "layout");
  let rafLongDelayMs = 0;
  if (rafs.length === 1 && frames.length === 1) {
    const waitDelayMs = ((frames[0]?.ts ?? 0) - click.end) / 1_000;
    if (waitDelayMs > 16 && !layouts.some((event) => event.ts < (frames[0]?.ts ?? 0))) {
      rafLongDelayMs = waitDelayMs - 16;
    }
  } else if (rafs.length > 0 && frames.length === 1) {
    throw new Error(
      `one FireAnimationFrame with ${rafs.length} RequestAnimationFrame events is not a valid trace`,
    );
  }
  let maxDeltaBetweenCommitsMs = 0;
  if (commits.length > 1) {
    maxDeltaBetweenCommitsMs = ((commits.at(-1)?.ts ?? 0) - (commits[0]?.ts ?? 0)) / 1_000;
  }
  return {
    durationMs: (commit.end - click.ts) / 1_000 - rafLongDelayMs,
    commits: commits.length,
    layouts: layouts.length,
    maxDeltaBetweenCommitsMs,
    rafLongDelayMs,
    droppedOtherProcessCommitEvents: during.some(
      (event) => event.pid !== click.pid && event.type === "commit",
    ),
    droppedOtherProcessEvents: dropped,
  };
};
