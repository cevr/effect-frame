import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { Behavior, Value, modify, select, spawn } from "@effect-frame/actor";
import type { LocalActorRef, SetValue, Source } from "@effect-frame/actor";
import { Dom, For, Show, View, mount, render } from "@effect-frame/view";
import { Effect, Exit, Ref, Scope } from "effect";
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

const textOf = (root: HTMLElement, selector: string): string =>
  root.querySelector(selector)?.textContent ?? "";

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
