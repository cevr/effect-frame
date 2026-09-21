import { registerDom } from "./dom-setup.js";

registerDom();

import { Behavior, Cell, Value, modify, select, spawn } from "effect-frame/actor";
import type { LocalActorRef, SetValue, Source } from "effect-frame/actor";
import { Dom, For, Show, View, mount, render } from "effect-frame/view";
import { Deferred, Effect, Exit, Option, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** A view with no input of its own still takes props: an empty record. */
interface NoProps {
  readonly _tag: "NoProps";
}

const noProps: NoProps = { _tag: "NoProps" };

/** A fresh detached root for each mount, so one test never sees another's nodes. */
const makeRoot = Effect.sync(() => document.createElement("main"));

const Counter = View.make((_props: NoProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    const count = yield* spawn(Behavior.value(0));
    return (
      <div>
        <span id="count">{view.bind(select(count.state, (n) => String(n)))}</span>
        <button
          id="up"
          onClick={view.event(() =>
            modify(count, (n) => n + 1).pipe(Effect.catchTag("ActorStopped", () => Effect.void)),
          )}
        >
          up
        </button>
      </div>
    );
  }),
);

interface Task {
  readonly id: string;
  readonly title: string;
}

interface ListProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
}

const TaskList = View.make((props: ListProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    return (
      <ul>
        <For each={props.tasks} keyBy={(task: Task) => task.id}>
          {(task: Source<Task>) => <li>{view.bind(task, (value) => value.title)}</li>}
        </For>
      </ul>
    );
  }),
);

interface ToggleProps {
  readonly open: Source<boolean>;
}

const Toggle = View.make((props: ToggleProps) =>
  Effect.succeed(
    <section>
      <Show when={props.open}>
        <p id="body">visible</p>
      </Show>
    </section>,
  ),
);

interface NestedToggleProps {
  readonly outer: Source<boolean>;
  readonly inner: Source<boolean>;
}

/**
 * An inner `Show` that is hidden while the outer one is visible. The outer
 * branch owns whatever the inner branch later reveals.
 */
const NestedToggle = View.make((props: NestedToggleProps) =>
  Effect.succeed(
    <section>
      <Show when={props.outer}>
        <>
          <Show when={props.inner}>
            <h1 id="title">t</h1>
          </Show>
        </>
      </Show>
    </section>,
  ),
);

const textOf = (root: HTMLElement, selector: string): string =>
  root.querySelector(selector)?.textContent ?? "";

/** A child asks for the capabilities itself; nothing passes them down. */
const Child = View.make((_props: NoProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    const label = yield* spawn(Behavior.value("child"));
    return <em id="child">{view.bind(label.state)}</em>;
  }),
);

const Parent = View.make((_props: NoProps) =>
  Effect.gen(function* () {
    return <div>{yield* Child.setup(noProps)}</div>;
  }),
);

interface HitsProps {
  readonly hits: Source<ReadonlyArray<string>>;
}

/**
 * The narrowing form: the branch reads a source of the tested value, which
 * exists only while the test holds, and the fallback draws otherwise.
 */
const Hits = View.make((props: HitsProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    return (
      <section>
        <Show when={props.hits} is={(xs) => xs.length > 0} fallback={<p id="none">no hits</p>}>
          {(xs) => <p id="first">{view.bind(select(xs, (found) => found[0] ?? ""))}</p>}
        </Show>
      </section>
    );
  }),
);

interface OptionalProps {
  readonly name: Source<Option.Option<string>>;
}

/** A type predicate narrows the branch's source to the `Some`. */
const Optional = View.make((props: OptionalProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    return (
      <section>
        <Show when={props.name} is={Option.isSome<string>}>
          {(some) => <b id="name">{view.bind(select(some, (found) => found.value))}</b>}
        </Show>
      </section>
    );
  }),
);

describe("browser view", () => {
  it.scoped("a bound source writes its first value and then every change", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* mount(Counter, noProps, Dom.host, root);
      expect(textOf(root, "#count")).toBe("0");

      const button = root.querySelector("#up");
      expect(button).toBeTruthy();
      button?.dispatchEvent(new Event("click"));
      yield* render;
      expect(textOf(root, "#count")).toBe("1");
    }),
  );

  it.scoped("a keyed list adds, removes, and reorders its rows", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
        ]),
      );
      yield* mount(TaskList, { tasks: tasks.state }, Dom.host, root);
      expect(titles(root)).toEqual(["alpha", "beta"]);

      yield* setTasks(tasks, [
        { id: "b", title: "beta" },
        { id: "a", title: "alpha" },
        { id: "c", title: "gamma" },
      ]);
      expect(titles(root)).toEqual(["beta", "alpha", "gamma"]);

      yield* setTasks(tasks, [{ id: "c", title: "gamma" }]);
      expect(titles(root)).toEqual(["gamma"]);
    }),
  );

  it.scoped("replacing an item under one key updates that row in place", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([{ id: "a", title: "alpha" }]),
      );
      yield* mount(TaskList, { tasks: tasks.state }, Dom.host, root);
      const before = root.querySelector("li");

      yield* setTasks(tasks, [{ id: "a", title: "ALPHA" }]);
      expect(titles(root)).toEqual(["ALPHA"]);
      expect(root.querySelector("li")).toBe(before);
    }),
  );

  it.scoped("Show adds and removes its children", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const open = yield* spawn(Behavior.value(false));
      yield* mount(Toggle, { open: open.state }, Dom.host, root);
      expect(root.querySelector("#body")).toBeNull();

      yield* open.call(Value.Set(true));
      yield* render;
      expect(textOf(root, "#body")).toBe("visible");

      yield* open.call(Value.Set(false));
      yield* render;
      expect(root.querySelector("#body")).toBeNull();
    }),
  );

  it.scoped("a child view reads View.Context from the parent's setup", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* mount(Parent, noProps, Dom.host, root);
      expect(textOf(root, "#child")).toBe("child");
    }),
  );

  it.scoped("Show narrows to the tested value and draws its fallback otherwise", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const hits = yield* spawn(Behavior.value<ReadonlyArray<string>>([]));
      yield* mount(Hits, { hits: hits.state }, Dom.host, root);
      expect(textOf(root, "#none")).toBe("no hits");
      expect(root.querySelector("#first")).toBeNull();

      yield* hits.call(Value.Set(["alpha", "beta"]));
      yield* render;
      expect(root.querySelector("#none")).toBeNull();
      expect(textOf(root, "#first")).toBe("alpha");

      // A change that keeps the test true updates the branch in place.
      yield* hits.call(Value.Set(["gamma"]));
      yield* render;
      expect(textOf(root, "#first")).toBe("gamma");

      yield* hits.call(Value.Set([]));
      yield* render;
      expect(root.querySelector("#first")).toBeNull();
      expect(textOf(root, "#none")).toBe("no hits");
    }),
  );

  it.scoped("Show accepts a type predicate and hands the branch the narrowed source", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const name = yield* spawn(Behavior.value<Option.Option<string>>(Option.none()));
      yield* mount(Optional, { name: name.state }, Dom.host, root);
      expect(root.querySelector("#name")).toBeNull();

      yield* name.call(Value.Set(Option.some("Ada")));
      yield* render;
      expect(textOf(root, "#name")).toBe("Ada");

      yield* name.call(Value.Set(Option.none()));
      yield* render;
      expect(root.querySelector("#name")).toBeNull();
    }),
  );

  it.scoped("Show removes what a nested Show revealed in the same update", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const outer = yield* spawn(Behavior.value(true));
      const inner = yield* spawn(Behavior.value(false));
      yield* mount(NestedToggle, { outer: outer.state, inner: inner.state }, Dom.host, root);
      expect(root.querySelector("#title")).toBeNull();

      // The inner branch reveals and the outer branch hides in one update.
      yield* inner.call(Value.Set(true));
      yield* outer.call(Value.Set(false));
      yield* render;
      expect(root.querySelector("#title")).toBeNull();

      // Showing the outer branch again draws the inner content exactly once.
      yield* outer.call(Value.Set(true));
      yield* render;
      expect(textOf(root, "#title")).toBe("t");
      expect(root.querySelectorAll("#title").length).toBe(1);

      // The reverse order leaves nothing behind either.
      yield* outer.call(Value.Set(false));
      yield* inner.call(Value.Set(false));
      yield* render;
      expect(root.querySelector("#title")).toBeNull();
      expect(root.querySelector("section")?.childNodes.length).toBe(0);
    }),
  );

  it.scoped("a hidden Show branch keeps no source subscribed", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const open = yield* spawn(Behavior.value(true));
      const count = yield* spawn(Behavior.value(0));
      // A plain counter: the projection is a pure function the stream runs,
      // and counting its runs is what this test observes.
      let reads = 0;
      const counted = select(count.state, (n) => {
        reads += 1;
        return String(n);
      });
      const Watched = View.make((_props: NoProps) =>
        Effect.gen(function* () {
          const view = yield* View.Context;
          return (
            <section>
              <Show when={open.state}>
                <p id="watched">{view.bind(counted)}</p>
              </Show>
            </section>
          );
        }),
      );
      yield* mount(Watched, noProps, Dom.host, root);
      expect(textOf(root, "#watched")).toBe("0");

      yield* open.call(Value.Set(false));
      yield* render;
      expect(root.querySelector("#watched")).toBeNull();

      // The branch's scope is closed, so its subscription projects nothing.
      const before = reads;
      yield* count.call(Value.Set(7));
      yield* render;
      expect(reads).toBe(before);

      // Showing it again subscribes afresh, against the current value.
      yield* open.call(Value.Set(true));
      yield* render;
      expect(textOf(root, "#watched")).toBe("7");
    }),
  );

  it.scoped("an event handler sends to the actor it closed over", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const Echo = View.make((_props: NoProps) =>
        Effect.gen(function* () {
          const view = yield* View.Context;
          return (
            <button id="say" onClick={view.event(() => Ref.update(seen, (all) => [...all, "hi"]))}>
              say
            </button>
          );
        }),
      );
      yield* mount(Echo, noProps, Dom.host, root);
      root.querySelector("#say")?.dispatchEvent(new Event("click"));
      yield* render;
      expect(yield* Ref.get(seen)).toEqual(["hi"]);
    }),
  );

  it.scoped("submit suppresses the form's own navigation before it runs", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const sent = yield* Ref.make(false);
      const Form = View.make((_props: NoProps) =>
        Effect.gen(function* () {
          const view = yield* View.Context;
          return (
            <form id="form" onSubmit={view.submit(() => Ref.set(sent, true))}>
              <button>go</button>
            </form>
          );
        }),
      );
      yield* mount(Form, noProps, Dom.host, root);

      const event = new Event("submit", { cancelable: true });
      root.querySelector("#form")?.dispatchEvent(event);
      yield* render;
      expect(event.defaultPrevented).toBe(true);
      expect(yield* Ref.get(sent)).toBe(true);
    }),
  );

  it.effect("closing the mount scope runs finalizers, stops actors, and clears nodes", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const finished = yield* Ref.make(false);
      const spawned = yield* Ref.make<ReadonlyArray<LocalActorRef<number, SetValue<number>>>>([]);

      const Owned = View.make((_props: NoProps) =>
        Effect.gen(function* () {
          const count = yield* spawn(Behavior.value(0));
          yield* Ref.update(spawned, (all) => [...all, count]);
          yield* Effect.addFinalizer(() => Ref.set(finished, true));
          return <p id="owned">owned</p>;
        }),
      );

      const scope = yield* Scope.make();
      yield* Scope.provide(mount(Owned, noProps, Dom.host, root), scope);
      expect(textOf(root, "#owned")).toBe("owned");

      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(finished)).toBe(true);
      expect(root.childNodes.length).toBe(0);

      const actors = yield* Ref.get(spawned);
      expect(actors.length).toBe(1);
      const stopped = yield* Effect.forEach(actors, (actor) =>
        Effect.exit(actor.send(Value.Set(1))),
      );
      expect(stopped.map(Exit.isFailure)).toEqual([true]);
    }),
  );
});

const titles = (root: HTMLElement): ReadonlyArray<string> =>
  Array.from(root.querySelectorAll("li")).map((node) => node.textContent ?? "");

const setTasks = Effect.fn("test.setTasks")(function* (
  tasks: LocalActorRef<ReadonlyArray<Task>, SetValue<ReadonlyArray<Task>>>,
  next: ReadonlyArray<Task>,
) {
  yield* tasks.call(Value.Set(next));
  yield* render;
});

// ---------------------------------------------------------------------------
// Row sources outside the graph
// ---------------------------------------------------------------------------

interface CountedListProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
  /** How many row subscriptions have ended. */
  readonly ended: Ref.Ref<number>;
}

/**
 * Each row derives a second source from its item through `changes`, the way
 * an app combines row state with its own. That subscription runs outside the
 * reactive graph, on a fiber of its own, so it must be owned twice over: by a
 * reactive root, or Solid never disposes its effect, and by the row's scope,
 * or the fiber outlives the row.
 */
const CountedList = View.make((props: CountedListProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    const shout = (task: Source<Task>): Source<string> => ({
      get: Effect.map(task.get, (value) => value.title.toUpperCase()),
      changes: Stream.ensuring(
        Stream.map(task.changes, (value) => value.title.toUpperCase()),
        Ref.update(props.ended, (n) => n + 1),
      ),
    });
    return (
      <ul>
        <For each={props.tasks} keyBy={(task: Task) => task.id}>
          {(task: Source<Task>) => <li>{view.bind(shout(task))}</li>}
        </For>
      </ul>
    );
  }),
);

describe("row sources", () => {
  it.scoped("a source derived from a row's changes follows the row and ends with it", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const ended = yield* Ref.make(0);
      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
        ]),
      );
      yield* mount(CountedList, { tasks: tasks.state, ended }, Dom.host, root);
      expect(titles(root)).toEqual(["ALPHA", "BETA"]);

      // The change reaches the derived source through the row's cell.
      yield* setTasks(tasks, [
        { id: "a", title: "alef" },
        { id: "b", title: "beta" },
      ]);
      expect(titles(root)).toEqual(["ALEF", "BETA"]);
      expect(yield* Ref.get(ended)).toBe(0);

      // Removing a row ends exactly that row's subscription.
      yield* setTasks(tasks, [{ id: "b", title: "beta" }]);
      yield* render;
      expect(titles(root)).toEqual(["BETA"]);
      expect(yield* Ref.get(ended)).toBe(1);
    }),
  );
});

interface CountedRowsProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
  /** Bumped by a row's finalizer, so a test can see a row's scope close. */
  readonly closed: Ref.Ref<number>;
}

/**
 * Rows with a setup of their own: each keeps a cell that counts its clicks,
 * reads `View.Context` itself, and registers a finalizer in the row scope.
 */
const CountedRows = View.make((props: CountedRowsProps) =>
  Effect.gen(function* () {
    const rows = yield* View.list({
      each: props.tasks,
      keyBy: (task: Task) => task.id,
      setup: (task: Source<Task>) =>
        Effect.gen(function* () {
          const view = yield* View.Context;
          const clicks = yield* Cell.make(0);
          yield* Effect.addFinalizer(() => Ref.update(props.closed, (n) => n + 1));
          return (
            <li>
              <span class="title">{view.bind(task, (value) => value.title)}</span>
              <button class="tap" onClick={view.event(() => clicks.update((n) => n + 1))}>
                {view.bind(clicks.state, String)}
              </button>
            </li>
          );
        }),
    });
    return <ul>{rows}</ul>;
  }),
);

interface LateRowsProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
  /** The row with this id waits for the gate before it has a body. */
  readonly slow: string;
  readonly gate: Deferred.Deferred<void>;
}

/** One row's setup suspends: it must land in its place, not at the end. */
const LateRows = View.make((props: LateRowsProps) =>
  Effect.gen(function* () {
    const rows = yield* View.list({
      each: props.tasks,
      keyBy: (task: Task) => task.id,
      setup: (task: Source<Task>) =>
        Effect.gen(function* () {
          const view = yield* View.Context;
          const current = yield* task.get;
          if (current.id === props.slow) {
            yield* Deferred.await(props.gate);
          }
          return <li>{view.bind(task, (value) => value.title)}</li>;
        }),
    });
    return <ul>{rows}</ul>;
  }),
);

describe("rows with a setup", () => {
  it.scoped("each row keeps its own state, and a row that leaves closes its scope", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const closed = yield* Ref.make(0);
      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
        ]),
      );
      yield* mount(CountedRows, { tasks: tasks.state, closed }, Dom.host, root);
      expect(titles(root)).toEqual(["alpha0", "beta0"]);

      const taps = root.querySelectorAll("button.tap");
      taps[1]?.dispatchEvent(new Event("click"));
      taps[1]?.dispatchEvent(new Event("click"));
      yield* render;
      expect(titles(root)).toEqual(["alpha0", "beta2"]);

      // Reordering keeps each row's state with its key.
      yield* setTasks(tasks, [
        { id: "b", title: "BETA" },
        { id: "a", title: "alpha" },
      ]);
      expect(titles(root)).toEqual(["BETA2", "alpha0"]);
      expect(yield* Ref.get(closed)).toBe(0);

      yield* setTasks(tasks, [{ id: "a", title: "alpha" }]);
      expect(titles(root)).toEqual(["alpha0"]);
      expect(yield* Ref.get(closed)).toBe(1);
    }),
  );

  it.scoped("a row whose setup suspends lands in its place when it completes", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const gate = yield* Deferred.make<void>();
      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
          { id: "c", title: "gamma" },
        ]),
      );
      yield* mount(LateRows, { tasks: tasks.state, slow: "b", gate }, Dom.host, root);
      expect(titles(root)).toEqual(["alpha", "gamma"]);

      yield* Deferred.succeed(gate, void 0);
      yield* render;
      expect(titles(root)).toEqual(["alpha", "beta", "gamma"]);
    }),
  );

  it.scoped("closing the mount interrupts a row setup still in flight", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const gate = yield* Deferred.make<void>();
      const tasks = yield* spawn(Behavior.value<ReadonlyArray<Task>>([{ id: "b", title: "beta" }]));
      const scope = yield* Scope.make();
      yield* Scope.provide(
        mount(LateRows, { tasks: tasks.state, slow: "b", gate }, Dom.host, root),
        scope,
      );
      expect(titles(root)).toEqual([]);

      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(gate, void 0);
      yield* render;
      expect(titles(root)).toEqual([]);
    }),
  );
});
