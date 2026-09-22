/* oxlint-disable effect/noNewError, effect/noNullish, effect/noTernary, effect/noThrowStatement -- this reducer mirrors the official trace parser and reports malformed external trace data as a bounded CLI failure. */

export interface ChromeTraceEvent {
  readonly name?: string;
  readonly ph?: string;
  readonly ts?: number;
  readonly dur?: number;
  readonly pid?: number;
  readonly args?: {
    readonly data?: {
      readonly type?: string;
    };
  };
}

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

const toTimingEvent = (entry: ChromeTraceEvent): TimingEvent | undefined => {
  const ts = numberOrZero(entry.ts);
  const dur = numberOrZero(entry.dur);
  const pid = numberOrZero(entry.pid);
  if (entry.name === "EventDispatch") {
    const type = entry.args?.data?.type;
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

const hasType = (types: ReadonlyArray<string>, event: TimingEvent): boolean =>
  types.includes(event.type);

/**
 * Reduce the Chrome trace with the same click-to-Commit rule as krausest.
 * Trace timestamps and durations are in microseconds; the result is ms.
 */
export const reduceChromeTrace = (
  entries: ReadonlyArray<ChromeTraceEvent>,
  startLogicEvent = "click",
): TraceReduction => {
  const events = relevantEvents(entries).sort((left, right) => left.end - right.end);
  const clicks = events.filter((event) => event.type === startLogicEvent);
  if (clicks.length !== 1) {
    throw new Error(`expected one ${startLogicEvent} event, found ${clicks.length}`);
  }
  const click = clicks[0];
  if (click === undefined) {
    throw new Error(`missing ${startLogicEvent} event`);
  }
  const during = events.filter((event) => event.ts > click.end || event.type === "click");
  const main = during.filter((event) => event.pid === click.pid);
  const dropped = main.length !== during.length;
  const commits = main.filter((event) => event.type === "commit");
  if (commits.length === 0) {
    throw new Error("no Commit event after click");
  }
  const startFrom = main.filter((event) =>
    hasType([startLogicEvent, "fireAnimationFrame", "timerFire", "layout", "functioncall"], event),
  );
  const start = startFrom.at(-1);
  if (start === undefined) {
    throw new Error("no post-click trace event from which to find Commit");
  }
  const firstCommit = commits.find((event) => event.ts > start.end);
  const commit = firstCommit ?? commits.at(-1);
  if (commit === undefined) {
    throw new Error("no Commit event after trace start");
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
