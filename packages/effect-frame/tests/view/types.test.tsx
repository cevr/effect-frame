import type { QueryState } from "effect-frame/actor";
import type { Host, Node as ViewNode } from "effect-frame/view";
import type { MatchNode } from "../../src/view/jsx-runtime.js";
import { For, Match, View } from "effect-frame/view";
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
    return <p onClick={View.event(() => Effect.void)}>{String(now)}</p>;
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
// PROTOTYPE (ticket #16): readiness requirements
// ---------------------------------------------------------------------------

/**
 * `ready` registers with a scope, so it requires one. The requirement is an
 * ordinary Effect service, which makes "a read outside a readiness scope" a
 * compile error rather than something the runtime has to detect and report.
 */
const readyOutsideAScope = (_props: NoProps) =>
  Effect.gen(function* () {
    const title = yield* View.ready(query, "");
    return <h1>{View.bind(title)}</h1>;
  });

/** Mounting it demands `LoadingScope`, which `mount` does not provide. */
const readyNeedsLoadingScope: Equals<
  ReturnType<typeof mountReadyOutside>,
  Effect.Effect<void, never, View.LoadingScope | Scope.Scope>
> = true;

const mountReadyOutside = () => View.mount(readyOutsideAScope, noProps, host, "root");

/**
 * The ticket's central claim, stated as a type rather than as a suppressed
 * error. `ready` with no `Loading` above it leaves `LoadingScope` in `R`, so
 * the mount is *not* assignable to an Effect that needs only a `Scope`: an
 * application cannot run it without providing the scope, and there is no
 * runtime check anywhere that could have caught this instead.
 *
 * A `@ts-expect-error` would have been the direct way to write it, but the
 * missing service is reported by `effect(missingEffectContext)`, a plugin
 * diagnostic that `@ts-expect-error` does not suppress. Asserting the
 * assignability is `false` proves the same thing and keeps the file clean.
 */
type RunnableWithoutScope = Effect.Effect<void, never, Scope.Scope>;

const readyOutsideIsNotRunnable: Equals<
  ReturnType<typeof mountReadyOutside> extends RunnableWithoutScope ? true : false,
  false
> = true;

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
 * `Errored` above it still compiles. Only a query whose failure someone must
 * show pays for an error boundary.
 */
const wrappedWithError = View.loading({
  fallback: <p>loading</p>,
  content: Effect.gen(function* () {
    const title = yield* View.ready(yield* View.orErrored(query), "");
    return <h1>{View.bind(title)}</h1>;
  }),
});

const orErroredKeepsItsOwnRequirement: Equals<
  ReturnType<typeof mountWrappedWithError>,
  Effect.Effect<void, never, View.ErroredScope | Scope.Scope>
> = true;

const mountWrappedWithError = () => View.mount(() => wrappedWithError, {}, host, "root");

describe("readiness types", () => {
  test("ready requires a scope the compiler must see provided", () => {
    expect(readyNeedsLoadingScope).toBe(true);
    expect(loadingDischargesItsScope).toBe(true);
    expect(orErroredKeepsItsOwnRequirement).toBe(true);
    expect(readyOutsideIsNotRunnable).toBe(true);
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
