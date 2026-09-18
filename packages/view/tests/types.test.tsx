import type { Host } from "@effect-frame/view";
import { View, mount } from "@effect-frame/view";
import type { Scope } from "effect";
import { Context, Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

/**
 * Compile-time checks. A view's setup is an ordinary Effect, so what it can
 * fail with and what it needs stay in the type of `mount`. The mounting
 * application must provide them; the view never hides them.
 */

class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()(
  "@effect-frame/view/tests/types.test/Clock",
) {}

class Offline extends Schema.TaggedError<Offline>()("Offline", {}) {}

declare const host: Host<string>;

/** A view with no input of its own still takes props: an empty record. */
interface NoProps {
  readonly _tag: "NoProps";
}

declare const noProps: NoProps;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Plain = View.make((_props: NoProps) => Effect.succeed(<p>plain</p>));

const NeedsClock = View.make((_props: NoProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    const clock = yield* Clock;
    const now = yield* clock.now;
    return <p onClick={view.event(() => Effect.void)}>{String(now)}</p>;
  }),
);

const MayFail = View.make((_props: NoProps) => Effect.fail(Offline.make()));

const mountPlain = () => mount(Plain, noProps, host, "root");
const mountNeedsClock = () => mount(NeedsClock, noProps, host, "root");
const mountMayFail = () => mount(MayFail, noProps, host, "root");

/** A plain view needs only the Scope that owns its nodes. */
const plainNeedsOnlyScope: Equals<
  ReturnType<typeof mountPlain>,
  Effect.Effect<void, never, Scope.Scope>
> = true;

/** `View.Context` is supplied by `mount`; a real service is not. */
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
