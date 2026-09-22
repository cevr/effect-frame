import { registerDom } from "./dom-setup.js";

registerDom();

import { Behavior, Value, spawn } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { Dom, For, Portal, Show, View, ViewTest, mount } from "effect-frame/view";
import type { Host } from "effect-frame/view";
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";
import * as Frame from "../../src/frame.js";

interface Task {
  readonly id: string;
  readonly title: string;
}

interface CompositeProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
  readonly into: Element;
}

const Composite = (props: CompositeProps) =>
  Effect.succeed(
    <>
      <p id="first">first</p>
      <For each={props.tasks} keyBy={(task: Task) => task.id}>
        {(task) => (
          <li data-task={View.bind(task, (value) => value.id)}>
            {View.bind(task, (value) => value.title)}
          </li>
        )}
      </For>
      <Portal into={props.into}>
        <p id="portal">portal</p>
      </Portal>
      <p id="after">after</p>
    </>,
  );

interface TurnoverProps {
  readonly open: Source<boolean>;
  readonly tasks: Source<ReadonlyArray<Task>>;
}

const Turnover = (props: TurnoverProps) =>
  Effect.succeed(
    <>
      <Show when={props.open}>
        <section id="branch">
          <p id="branch-child">branch</p>
        </section>
      </Show>
      <For each={props.tasks} keyBy={(task: Task) => task.id}>
        {(task) => (
          <article id={View.bind(task, (value) => `row-${value.id}`)}>
            <span id={View.bind(task, (value) => `row-child-${value.id}`)}>
              {View.bind(task, (value) => value.title)}
            </span>
          </article>
        )}
      </For>
    </>,
  );

const hostLabel = (node: Node): string => {
  if (node instanceof Element) {
    if (node.id.length > 0) {
      return node.id;
    }
    return node.tagName.toLowerCase();
  }
  return Option.getOrElse(Option.fromNullishOr(node.textContent), () => "");
};

const hasElement = (root: Node, selector: string): boolean => {
  if (!(root instanceof Element)) {
    return false;
  }
  return Option.isSome(Option.fromNullishOr(root.querySelector(selector)));
};

const articleIds = (root: Node): string => {
  if (!(root instanceof Element)) {
    return "";
  }
  return Array.from(root.querySelectorAll("article"))
    .map((row) => row.id)
    .join(",");
};

describe("mount failure ownership", () => {
  it.scoped("removes partial list, fragment, keyed row, and portal writes only", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const unrelatedRoot = document.createElement("aside");
      unrelatedRoot.id = "unrelated-root";
      unrelatedRoot.textContent = "keep root";
      root.appendChild(unrelatedRoot);

      const into = document.createElement("section");
      const unrelatedPortal = document.createElement("aside");
      unrelatedPortal.id = "unrelated-portal";
      unrelatedPortal.textContent = "keep portal";
      into.appendChild(unrelatedPortal);

      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
        ]),
      );
      const host: Host<Node> = {
        ...Dom.host,
        insert: (parent, node, anchor) => {
          if (node instanceof Element && node.id === "after") {
            Option.getOrThrow(Option.none());
          }
          Dom.host.insert(parent, node, anchor);
        },
      };

      const outcome = yield* Effect.exit(
        mount(Composite, { tasks: tasks.state, into }, host, root),
      );

      expect(Exit.isFailure(outcome)).toBe(true);
      expect(Array.from(root.childNodes)).toEqual([unrelatedRoot]);
      expect(Array.from(into.childNodes)).toEqual([unrelatedPortal]);
      expect(root.querySelector("#first")).toBeNull();
      expect(root.querySelector("li")).toBeNull();
      expect(into.querySelector("#portal")).toBeNull();
    }),
  );

  it.scoped("forgets nested host ownership through repeated branch and row turnover", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const open = yield* spawn(Behavior.value(true));
      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
        ]),
      );
      const removed: Array<string> = [];
      const host: Host<Node> = {
        ...Dom.host,
        remove: (parent, node) => {
          removed.push(hostLabel(node));
          Dom.host.remove(parent, node);
        },
      };
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (observedHost, mountRoot) =>
          mount(Turnover, { open: open.state, tasks: tasks.state }, observedHost, mountRoot),
      });

      yield* page.waitFor({
        label: "initial branch and rows are mounted",
        until: (actualRoot) =>
          hasElement(actualRoot, "#branch") && articleIds(actualRoot) === "row-a,row-b",
      });

      yield* page.act(open.call(Value.Set(false)), {
        label: "branch is hidden",
        until: (actualRoot) => !hasElement(actualRoot, "#branch"),
      });
      yield* page.act(tasks.call(Value.Set([{ id: "b", title: "beta" }])), {
        label: "first row is removed",
        until: (actualRoot) => articleIds(actualRoot) === "row-b",
      });
      yield* page.act(open.call(Value.Set(true)), {
        label: "branch is shown again",
        until: (actualRoot) => hasElement(actualRoot, "#branch"),
      });
      yield* page.act(tasks.call(Value.Set([{ id: "c", title: "gamma" }])), {
        label: "second row is replaced",
        until: (actualRoot) => articleIds(actualRoot) === "row-c",
      });
      yield* page.act(open.call(Value.Set(false)), {
        label: "branch is hidden for the final time",
        until: (actualRoot) => !hasElement(actualRoot, "#branch"),
      });
      yield* page.act(tasks.call(Value.Set([])), {
        label: "last row is removed",
        until: (actualRoot) => !hasElement(actualRoot, "article"),
      });

      const beforeClose = [...removed];
      yield* page.close;
      expect(root.childNodes).toHaveLength(0);
      expect(removed).toEqual(beforeClose);
    }),
  );

  it.scoped.layer(Frame.layer({ name: "mount-failure" }))(
    "releases a failed setup registration while the caller scope stays live",
    () =>
      Effect.gen(function* () {
        let released = 0;
        const Broken = () =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.void, (_value, _exit) =>
              Effect.sync(() => void (released += 1)),
            );
            return yield* Effect.die("setup failed");
          });
        const caller = yield* Scope.make();
        const root = document.createElement("main");
        const outcome = yield* Scope.provide(
          Effect.exit(mount(Broken, {}, Dom.host, root)),
          caller,
        );

        expect(Exit.isFailure(outcome)).toBe(true);
        expect(released).toBe(1);
        expect((yield* Frame.inspect).mounts).toHaveLength(0);
        yield* Scope.close(caller, Exit.void);
        expect(released).toBe(1);
      }),
  );

  it.scoped.layer(Frame.layer({ name: "mount-interruption" }))(
    "releases an interrupted setup registration before caller scope closure",
    () =>
      Effect.gen(function* () {
        let released = 0;
        const started = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        const Blocked = () =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.void, (_value, _exit) =>
              Effect.sync(() => void (released += 1)),
            );
            yield* Deferred.succeed(started, void 0);
            yield* Deferred.await(hold);
            return <p id="blocked">blocked</p>;
          });
        const caller = yield* Scope.make();
        const root = document.createElement("main");
        const fiber = yield* Effect.forkChild(
          mount(Blocked, {}, Dom.host, root).pipe(Scope.provide(caller)),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);

        expect(released).toBe(1);
        expect((yield* Frame.inspect).mounts).toHaveLength(0);
        expect(root.childNodes).toHaveLength(0);
        yield* Scope.close(caller, Exit.void);
        expect(released).toBe(1);
      }),
  );
});
