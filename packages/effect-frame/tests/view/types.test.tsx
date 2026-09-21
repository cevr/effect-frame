import type { Source } from "effect-frame/actor";
import type { ErroredScope, Host, LoadingScope, QueryState } from "effect-frame/view";
import { Loading, View, mount, orErrored, ready } from "effect-frame/view";
import type { Scope } from "effect";
import { Context, Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

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
declare const query: Source<QueryState.QueryState<string, string>>;

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

const mountPlain = () => mount(Plain, noProps, host, "root");
const mountNeedsClock = () => mount(NeedsClock, noProps, host, "root");
const mountMayFail = () => mount(MayFail, noProps, host, "root");

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
    const title = yield* ready(query, "");
    return <h1>{View.bind(title)}</h1>;
  });

/** Mounting it demands `LoadingScope`, which `mount` does not provide. */
const readyNeedsLoadingScope: Equals<
  ReturnType<typeof mountReadyOutside>,
  Effect.Effect<void, never, LoadingScope | Scope.Scope>
> = true;

const mountReadyOutside = () => mount(readyOutsideAScope, noProps, host, "root");

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
const wrapped = Loading({
  fallback: <p>loading</p>,
  children: Effect.gen(function* () {
    const title = yield* ready(query, "");
    return <h1>{View.bind(title)}</h1>;
  }),
});

const loadingDischargesItsScope: Equals<
  ReturnType<typeof mountWrapped>,
  Effect.Effect<void, never, Scope.Scope>
> = true;

const mountWrapped = () => mount(() => wrapped, {}, host, "root");

/**
 * `orErrored` requires `ErroredScope` separately, so a `Loading` with no
 * `Errored` above it still compiles. Only a query whose failure someone must
 * show pays for an error boundary.
 */
const wrappedWithError = Loading({
  fallback: <p>loading</p>,
  children: Effect.gen(function* () {
    const title = yield* ready(yield* orErrored(query), "");
    return <h1>{View.bind(title)}</h1>;
  }),
});

const orErroredKeepsItsOwnRequirement: Equals<
  ReturnType<typeof mountWrappedWithError>,
  Effect.Effect<void, never, ErroredScope | Scope.Scope>
> = true;

const mountWrappedWithError = () => mount(() => wrappedWithError, {}, host, "root");

describe("readiness types", () => {
  test("ready requires a scope the compiler must see provided", () => {
    expect(readyNeedsLoadingScope).toBe(true);
    expect(loadingDischargesItsScope).toBe(true);
    expect(orErroredKeepsItsOwnRequirement).toBe(true);
    expect(readyOutsideIsNotRunnable).toBe(true);
  });
});
