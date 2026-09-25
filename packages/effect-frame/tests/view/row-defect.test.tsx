import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, Behavior, Value } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { Dom, View } from "effect-frame/view";
import type { Node } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Cause, Deferred, Duration, Effect, Exit, Option, Result, Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * A row's or a branch's setup runs on a fiber of its own, after the mount
 * returned. A defect it meets closes the mount's scope with that defect, as
 * a refused Portal does: the view's owner sees it, and the rest of the
 * process keeps running. An interrupt from the row's own scope closing is
 * the row leaving, not a defect.
 */

type Closed = Deferred.Deferred<Exit.Exit<unknown, unknown>>;

/** The defect a mount's scope closed with, when it closed with one. */
const defectOf = (exit: Exit.Exit<unknown, unknown>): Option.Option<unknown> =>
  Exit.match(exit, {
    onSuccess: () => Option.none(),
    onFailure: (cause) => Result.getSuccess(Cause.findDefect(cause)),
  });

/** The view's own finalizer hands the exit its mount scope closed with to `closed`. */
const observed = (closed: Closed) => Effect.addFinalizer((exit) => Deferred.succeed(closed, exit));

const Rows = (props: { readonly items: Source<ReadonlyArray<string>>; readonly closed: Closed }) =>
  Effect.gen(function* () {
    yield* observed(props.closed);
    const rows = yield* View.list({
      each: props.items,
      keyBy: (item) => item,
      row: (item) =>
        Effect.flatMap(item.get, (value) => {
          if (value === "boom") {
            return Effect.die("boom");
          }
          return Effect.succeed(<li>{value}</li>);
        }),
    });
    return <ul>{rows}</ul>;
  });

const Branch = (props: {
  readonly open: Source<boolean>;
  readonly content: Effect.Effect<Node, never, Scope.Scope>;
  readonly label: Source<string>;
  readonly closed: Closed;
}) =>
  Effect.gen(function* () {
    yield* observed(props.closed);
    const region = yield* View.show({ when: props.open, content: props.content });
    return (
      <section>
        <p id="own">{View.bind(props.label, (label) => label)}</p>
        {region}
      </section>
    );
  });

const Label = (props: { readonly label: Source<string> }) =>
  Effect.succeed(<p id="label">{View.bind(props.label, (label) => label)}</p>);

/** A second mount in the same process, which must keep following its source. */
const bystander = Effect.gen(function* () {
  const label = yield* Actor.local(Behavior.value("before"));
  const main = document.createElement("main");
  const page = yield* ViewTest.make({
    host: Dom.host,
    root: main,
    setup: (host, root) => View.mount(Label, { label: label.state }, host, root),
  });
  return {
    followsItsSource: page.act(label.call(Value.Set("after")), {
      label: "another mount still follows its source",
      until: () => main.querySelector("#label")?.textContent === "after",
    }),
  };
});

const awaitClosed = (closed: Closed) =>
  Deferred.await(closed).pipe(Effect.timeout(Duration.seconds(2)));

describe("a row's setup defect after mount", () => {
  it.scoped("a For row whose setup dies closes its mount with the defect", () =>
    Effect.gen(function* () {
      const items = yield* Actor.local(Behavior.value<ReadonlyArray<string>>(["a"]));
      const closed = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      const mountScope = yield* Scope.make();
      yield* View.mount(
        Rows,
        { items: items.state, closed },
        Dom.host,
        document.createElement("main"),
      ).pipe(Scope.provide(mountScope));
      const other = yield* bystander;

      yield* items.call(Value.Set<ReadonlyArray<string>>(["a", "boom"]));
      const exit = yield* awaitClosed(closed);
      expect(exit.pipe(defectOf)).toEqual(Option.some("boom"));

      yield* other.followsItsSource;
    }),
  );

  it.scoped("a View.show branch whose setup dies when revealed closes its mount", () =>
    Effect.gen(function* () {
      const open = yield* Actor.local(Behavior.value(false));
      const label = yield* Actor.local(Behavior.value("own"));
      const closed = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      const mountScope = yield* Scope.make();
      yield* View.mount(
        Branch,
        {
          open: open.state,
          content: Effect.andThen(Effect.yieldNow, Effect.die("boom")),
          label: label.state,
          closed,
        },
        Dom.host,
        document.createElement("main"),
      ).pipe(Scope.provide(mountScope));
      const other = yield* bystander;

      yield* open.call(Value.Set(true));
      const exit = yield* awaitClosed(closed);
      expect(exit.pipe(defectOf)).toEqual(Option.some("boom"));

      yield* other.followsItsSource;
    }),
  );

  it.scoped("a row whose setup dies while the mount builds fails the mount", () =>
    Effect.gen(function* () {
      const items = yield* Actor.local(Behavior.value<ReadonlyArray<string>>(["boom"]));
      const closed = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      const exit = yield* Effect.exit(
        View.mount(Rows, { items: items.state, closed }, Dom.host, document.createElement("main")),
      );
      expect(exit.pipe(defectOf)).toEqual(Option.some("boom"));
    }),
  );

  it.scoped("hiding a branch whose setup is still running leaves the mount open", () =>
    Effect.gen(function* () {
      const open = yield* Actor.local(Behavior.value(false));
      const label = yield* Actor.local(Behavior.value("before"));
      const closed = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      const started = yield* Deferred.make<void>();
      const main = document.createElement("main");
      const page = yield* ViewTest.make({
        host: Dom.host,
        root: main,
        setup: (host, root) =>
          View.mount(
            Branch,
            {
              open: open.state,
              content: Effect.andThen(Deferred.done(started, Exit.void), Effect.never),
              label: label.state,
              closed,
            },
            host,
            root,
          ),
      });

      yield* open.call(Value.Set(true));
      yield* Deferred.await(started).pipe(Effect.timeout(Duration.seconds(2)));
      yield* open.call(Value.Set(false));
      yield* page.act(label.call(Value.Set("after")), {
        label: "the mount still follows its source after the branch left",
        until: () => main.querySelector("#own")?.textContent === "after",
      });
      expect(yield* Deferred.isDone(closed)).toBe(false);
    }),
  );
});
