import type { QueryState } from "effect-frame/actor";
import type { Host, Node as ViewNode, ScopesClosed } from "effect-frame/view";
import type { MatchNode } from "../../src/view/jsx-runtime.js";
import { For, Html, Match, Remote, View } from "effect-frame/view";
import * as Driven from "effect-frame/view/driven";
import type { AnyContract } from "effect-frame/actor/client";
import { Source } from "effect-frame/actor";
import type { Scope } from "effect";
import { Context, Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";
import type * as ViewEntryModule from "effect-frame/view";

/**
 * Compile-time checks. A view's setup is an ordinary Effect, so what it can
 * fail with and what it needs stay in the type of `mount`. The mounting
 * application must provide them; the view never hides them.
 */

class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()(
  "effect-frame/tests/view/types.test/Clock",
) {}

class Offline extends Schema.TaggedError<Offline>()("Offline", {}) {}

declare const host: Host<string>;

/** A query state source, as the Query primitive (#17) will hand one over. */
declare const query: Source<QueryState<string, string>>;

/** A view with no input of its own still takes props: an empty record. */
interface NoProps {
  readonly _tag: "NoProps";
}

declare const noProps: NoProps;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Plain = (_props: NoProps) => Effect.succeed(<p>plain</p>);

const NeedsClock = (_props: NoProps) =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    const now = yield* clock.now;
    return <p onClick={View.event(Effect.void)}>{String(now)}</p>;
  });

const MayFail = (_props: NoProps) => Effect.fail(Offline.make());

const mountPlain = () => View.mount(Plain, noProps, host, "root");
const mountNeedsClock = () => View.mount(NeedsClock, noProps, host, "root");
const mountMayFail = () => View.mount(MayFail, noProps, host, "root");

/** A plain view needs only the Scope that owns its nodes. */
const plainNeedsOnlyScope: Equals<
  ReturnType<typeof mountPlain>,
  Effect.Effect<void, never, Scope.Scope>
> = true;

/** `mount` supplies nothing of its own: a real service stays visible. */
const clockStaysVisible: Equals<
  ReturnType<typeof mountNeedsClock>,
  Effect.Effect<void, never, Clock | Scope.Scope>
> = true;

/** An expected failure in setup stays in the error channel. */
const failureStaysVisible: Equals<
  ReturnType<typeof mountMayFail>,
  Effect.Effect<void, Offline, Scope.Scope>
> = true;

describe("view types", () => {
  test("setup's errors and services stay visible in mount", () => {
    expect(plainNeedsOnlyScope).toBe(true);
    expect(clockStaysVisible).toBe(true);
    expect(failureStaysVisible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Readiness requirements (#16): an open boundary is refused where it is mounted
// ---------------------------------------------------------------------------

/**
 * `ready` registers with a scope, so it requires one. The requirement is an
 * ordinary Effect service, so "a read outside a readiness scope" stays in
 * the view's `R`, and `View.mount` refuses a view whose `R` still holds a
 * readiness scope, with an error that names the fix.
 */
const readyOutsideAScope = (_props: NoProps) =>
  Effect.gen(function* () {
    const title = yield* View.ready(query, "");
    return <h1>{View.bind(title)}</h1>;
  });

/** The requirement is in the view's own type. */
const readyNeedsLoadingScope: Equals<
  Effect.Services<ReturnType<typeof readyOutsideAScope>>,
  View.LoadingScope | Scope.Scope
> = true;

// @ts-expect-error View.ready needs a View.loading above it.
const mountReadyOutside = () => View.mount(readyOutsideAScope, noProps, host, "root");

/** The brand names the fix: the missing member is the sentence. */
const loadingOpen: Equals<
  ScopesClosed<View.LoadingScope | Clock>,
  { readonly "View.ready needs a View.loading above it": View.LoadingScope }
> = true;
const erroredOpen: Equals<
  ScopesClosed<View.ErroredScope | Clock>,
  { readonly "View.orErrored needs a View.errored above it": View.ErroredScope }
> = true;
const closed: Equals<ScopesClosed<Clock | Scope.Scope>, unknown> = true;

/** `Loading` discharges the scope it provides, and leaks nothing. */
const wrapped = View.loading({
  fallback: <p>loading</p>,
  content: Effect.gen(function* () {
    const title = yield* View.ready(query, "");
    return <h1>{View.bind(title)}</h1>;
  }),
});

const loadingDischargesItsScope: Equals<
  ReturnType<typeof mountWrapped>,
  Effect.Effect<void, never, Scope.Scope>
> = true;

const mountWrapped = () => View.mount(() => wrapped, {}, host, "root");

/**
 * `orErrored` requires `ErroredScope` separately, so a `Loading` with no
 * `Errored` above it keeps it. Only a query whose failure someone must show
 * pays for an error boundary, and `View.mount` names the one that is missing.
 */
const wrappedWithError = View.loading({
  fallback: <p>loading</p>,
  content: Effect.gen(function* () {
    const title = yield* View.ready(yield* View.orErrored(query), "");
    return <h1>{View.bind(title)}</h1>;
  }),
});

const orErroredKeepsItsOwnRequirement: Equals<
  Effect.Services<typeof wrappedWithError>,
  View.ErroredScope | Scope.Scope
> = true;

// @ts-expect-error View.orErrored needs a View.errored above it.
const mountWrappedWithError = () => View.mount(() => wrappedWithError, {}, host, "root");

/** Every place a view's services are final checks them the same way. */
// @ts-expect-error View.ready needs a View.loading above it.
const renderReadyOutside = () => Html.renderToString(readyOutsideAScope, noProps);
declare const drive: Remote.Drive<AnyContract>;
// @ts-expect-error View.ready needs a View.loading above it.
const drawReadyOutside = () => Remote.draw(readyOutsideAScope, noProps, drive, "");
// @ts-expect-error View.ready needs a View.loading above it.
const sessionReadyOutside = () => Driven.session(readyOutsideAScope, noProps, drive);

describe("readiness types", () => {
  test("an open readiness scope is refused where the view is mounted", () => {
    expect(readyNeedsLoadingScope).toBe(true);
    expect([loadingOpen, erroredOpen, closed]).toEqual([true, true, true]);
    expect(loadingDischargesItsScope).toBe(true);
    expect(orErroredKeepsItsOwnRequirement).toBe(true);
    void mountReadyOutside;
    void mountWrappedWithError;
    void renderReadyOutside;
    void drawReadyOutside;
    void sessionReadyOutside;
  });
});

// ---------------------------------------------------------------------------
// Match is exhaustive at the type level
// ---------------------------------------------------------------------------

type Light = { readonly _tag: "Red" } | { readonly _tag: "Green"; readonly seconds: number };

declare const light: Source<Light>;

/** Every tag present, each case given a source of its own member. */
const complete = () =>
  Match({
    on: light,
    cases: {
      Red: () => <p>stop</p>,
      Green: (green) => <p>{View.bind(Source.select(green, (g) => String(g.seconds)))}</p>,
    },
  });

/** A missing case is a compile error, so a new member cannot be forgotten. */
// @ts-expect-error `Green` is not handled
const incomplete = () => <Match on={light} cases={{ Red: () => <p>stop</p> }} />;

/** A case for a tag the union lacks is a compile error too. */
const surplus = () => (
  <Match
    on={light}
    // @ts-expect-error `Blue` is not a member
    cases={{ Red: () => <p />, Green: () => <p />, Blue: () => <p /> }}
  />
);

const matchIsExhaustive: Equals<ReturnType<typeof complete>, MatchNode<Light>> = true;
void incomplete;
void surplus;
void matchIsExhaustive;

// ---------------------------------------------------------------------------
// A keyed For infers its item through an inline select
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  readonly label: string;
}

declare const rows: Source<{ readonly items: ReadonlyArray<Row> }>;

/**
 * `select` has one signature, so an inline projection in `each` gives `For`
 * its item type: `keyBy` and the row read `Row` with no annotation.
 */
const inlineSelect = () => (
  <For each={Source.select(rows, (state) => state.items)} keyBy={(row) => row.id}>
    {(row) => <li>{View.bind(Source.select(row, (one) => one.label))}</li>}
  </For>
);
void inlineSelect;

// ---------------------------------------------------------------------------
// The kind rule of effect-frame/view
// ---------------------------------------------------------------------------

type ViewEntry = typeof ViewEntryModule;

/** The namespaces of the entry: every function and Effect lives in one. */
type EntryNamespaces = "View" | "Dom" | "Html" | "Remote";

type ValueKeys = keyof ViewEntry & string;

/** A flat lowercase value would be a function outside a namespace. */
type LowercaseKeys = { [K in ValueKeys]: K extends Capitalize<K> ? never : K }[ValueKeys];

/** Every other flat PascalCase value must be a JSX tag: sync, returns a `Node`. */
type TagKeys = Exclude<ValueKeys, LowercaseKeys | EntryNamespaces>;

type IsTag<F> = F extends (props: never) => infer Out
  ? [Out] extends [ViewNode]
    ? true
    : false
  : false;

const noFlatFunction: Equals<LowercaseKeys, never> = true;
const everyFlatValueIsATag: Equals<{ [K in TagKeys]: IsTag<ViewEntry[K]> }[TagKeys], true> = true;
/** The tags, named, so a new flat value is a decision this file records. */
const theTags: Equals<TagKeys, "Await" | "For" | "Match" | "Portal" | "Show"> = true;

describe("the view entry's kind rule", () => {
  test("a flat PascalCase value is a tag or a namespace; functions live in View", () => {
    expect(noFlatFunction).toBe(true);
    expect(everyFlatValueIsATag).toBe(true);
    expect(theTags).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A handler that reads no event is its Effect
// ---------------------------------------------------------------------------

declare const addPane: Effect.Effect<void>;
declare const draft: Source<string>;

/** `View.event` and `View.submit` take a handler, or the Effect it would return. */
const handlerForms = () => (
  <form onSubmit={View.submit(Effect.flatMap(draft.get, () => addPane))}>
    <input onInput={View.event((event) => Effect.log(event.value))} />
    <button type="button" onClick={View.event(addPane)}>
      add
    </button>
  </form>
);

/** What stays refused: a raw Effect, a raw function, a raw Source, and a failure. */
const refusedHandlers = () => (
  <div>
    {/* @ts-expect-error an Effect in an on* prop names no handler kind */}
    <button type="button" onClick={addPane} />
    {/* @ts-expect-error a raw function is wrapped with View.event */}
    <button type="button" onClick={() => addPane} />
    {/* @ts-expect-error a raw Source is wrapped with View.bind */}
    <p>{draft}</p>
  </div>
);

/** A handler's Effect has no error channel, in either form. */
// @ts-expect-error `Offline` is not handled
// @effect-diagnostics-next-line missingEffectError:off
const failingEvent = View.event(Effect.fail(Offline.make()));
// @ts-expect-error `Offline` is not handled
// @effect-diagnostics-next-line missingEffectError:off
const failingSubmit = View.submit(Effect.fail(Offline.make()));

describe("handler forms", () => {
  test("an Effect is a handler that reads no event; the refusals stay", () => {
    void handlerForms;
    void refusedHandlers;
    void failingEvent;
    void failingSubmit;
    expect(true).toBe(true);
  });
});
