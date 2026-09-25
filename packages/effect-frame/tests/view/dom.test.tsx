import { registerDom } from "./dom-setup.js";

registerDom();

import { Behavior, Cell, Value, modify, select, spawn } from "effect-frame/actor";
import type { LocalActorRef, SetValue, Source } from "effect-frame/actor";
import { Dom, For, Match, Portal, Show, View, ViewTest, mount } from "effect-frame/view";
import type { Host } from "effect-frame/view";
import { Deferred, Effect, Exit, Option, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** A view with no input of its own still takes props: an empty record. */
interface NoProps {
  readonly _tag: "NoProps";
}

const noProps: NoProps = { _tag: "NoProps" };

/** A fresh detached root for each mount, so one test never sees another's nodes. */
const makeRoot = Effect.sync(() => document.createElement("main"));

const pageMount = <Props, E, R>(root: Node, view: View.View<Props, E, R>, props: Props) =>
  ViewTest.make({
    host: Dom.host,
    root,
    setup: (host, mountRoot) => mount(view, props, host, mountRoot),
  });

const Counter = (_props: NoProps) =>
  Effect.gen(function* () {
    const count = yield* spawn(Behavior.value(0));
    return (
      <div>
        <span id="count">{View.bind(select(count.state, (n) => String(n)))}</span>
        <button
          id="up"
          onClick={View.event(() =>
            modify(count, (n) => n + 1).pipe(Effect.catchTag("ActorStopped", () => Effect.void)),
          )}
        >
          up
        </button>
      </div>
    );
  });

interface Task {
  readonly id: string;
  readonly title: string;
}

interface ListProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
}

const TaskList = (props: ListProps) =>
  Effect.succeed(
    <ul>
      <For each={props.tasks} keyBy={(task: Task) => task.id}>
        {(task: Source<Task>) => <li>{View.bind(task, (value) => value.title)}</li>}
      </For>
    </ul>,
  );

interface ToggleProps {
  readonly open: Source<boolean>;
}

const Toggle = (props: ToggleProps) =>
  Effect.succeed(
    <section>
      <Show when={props.open}>
        <p id="body">visible</p>
      </Show>
    </section>,
  );

interface NestedToggleProps {
  readonly outer: Source<boolean>;
  readonly inner: Source<boolean>;
}

/**
 * An inner `Show` that is hidden while the outer one is visible. The outer
 * branch owns whatever the inner branch later reveals.
 */
const NestedToggle = (props: NestedToggleProps) =>
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
  );

const textOf = (root: HTMLElement, selector: string): string =>
  root.querySelector(selector)?.textContent ?? "";

const textAt = (root: Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return textOf(root, selector);
};

const hasAt = (root: Node, selector: string): boolean => {
  if (!(root instanceof HTMLElement)) {
    return false;
  }
  return Option.isSome(Option.fromNullishOr(root.querySelector(selector)));
};

/** A child asks for the capabilities itself; nothing passes them down. */
const Child = (_props: NoProps) =>
  Effect.gen(function* () {
    const label = yield* spawn(Behavior.value("child"));
    return <em id="child">{View.bind(label.state)}</em>;
  });

const Parent = (_props: NoProps) =>
  Effect.gen(function* () {
    return <div>{yield* Child(noProps)}</div>;
  });

interface HitsProps {
  readonly hits: Source<ReadonlyArray<string>>;
}

/**
 * The narrowing form: the branch reads a source of the tested value, which
 * exists only while the test holds, and the fallback draws otherwise.
 */
const Hits = (props: HitsProps) =>
  Effect.succeed(
    <section>
      <Show when={props.hits} is={(xs) => xs.length > 0} fallback={<p id="none">no hits</p>}>
        {(xs) => <p id="first">{View.bind(select(xs, (found) => found[0] ?? ""))}</p>}
      </Show>
    </section>,
  );

interface OptionalProps {
  readonly name: Source<Option.Option<string>>;
}

/** A type predicate narrows the branch's source to the `Some`. */
const Optional = (props: OptionalProps) =>
  Effect.succeed(
    <section>
      <Show when={props.name} is={Option.isSome<string>}>
        {(some) => <b id="name">{View.bind(select(some, (found) => found.value))}</b>}
      </Show>
    </section>,
  );

type Job =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly percent: number }
  | { readonly _tag: "Done"; readonly output: string };

interface JobProps {
  readonly job: Source<Job>;
}

/**
 * One branch per tag. Each case reads a source of its own member, which
 * exists only while that member holds; a change that keeps the tag updates
 * the drawn branch in place.
 */
const JobView = (props: JobProps) =>
  Effect.succeed(
    <section>
      <Match
        on={props.job}
        cases={{
          Idle: () => <p id="idle">idle</p>,
          Running: (running) => (
            <p id="running">{View.bind(select(running, (r) => `${r.percent}%`))}</p>
          ),
          Done: (done) => <p id="done">{View.bind(select(done, (d) => d.output))}</p>,
        }}
      />
    </section>,
  );

interface AttachProps {
  readonly open: Source<boolean>;
  readonly log: Ref.Ref<ReadonlyArray<string>>;
  readonly attached: Deferred.Deferred<void>;
  readonly gone: Deferred.Deferred<void>;
}

/**
 * A behaviour runs once its element is in the document, in the scope of
 * the branch that owns the element; its finalizer runs when the branch
 * leaves. Two compose in order.
 */
const Attaching = (props: AttachProps) =>
  Effect.succeed(
    <section>
      <Show when={props.open}>
        <input
          id="field"
          attach={[
            Dom.attach((element) =>
              Effect.gen(function* () {
                yield* Ref.update(props.log, (xs) => [...xs, `first:${element.isConnected}`]);
                yield* Deferred.succeed(props.attached, void 0);
                yield* Effect.addFinalizer(() =>
                  Effect.andThen(
                    Ref.update(props.log, (xs) => [...xs, "gone"]),
                    Deferred.succeed(props.gone, void 0),
                  ),
                );
              }),
            ),
            Dom.attach((element) =>
              Effect.sync(() => {
                if (element instanceof HTMLInputElement) {
                  element.focus();
                }
              }),
            ),
          ]}
        />
      </Show>
    </section>,
  );

interface PortalProps {
  readonly open: Source<boolean>;
  readonly into: Element;
}

/** A dialog drawn under another node, owned by the branch that opened it. */
const WithPortal = (props: PortalProps) =>
  Effect.succeed(
    <section>
      <Show when={props.open}>
        <Portal into={props.into}>
          <dialog id="modal">hello</dialog>
        </Portal>
      </Show>
    </section>,
  );

describe("browser view", () => {
  it.scoped("a bound source writes its first value and then every change", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const page = yield* pageMount(root, Counter, noProps);
      expect(textOf(root, "#count")).toBe("0");

      const button = root.querySelector("#up");
      expect(button).toBeTruthy();
      yield* page.act(
        Effect.sync(() => button?.dispatchEvent(new Event("click"))),
        {
          label: "counter increments from a click",
          until: (actualRoot) => textAt(actualRoot, "#count") === "1",
        },
      );
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
      const page = yield* pageMount(root, TaskList, { tasks: tasks.state });
      expect(titles(root)).toEqual(["alpha", "beta"]);

      yield* page.act(
        setTasks(tasks, [
          { id: "b", title: "beta" },
          { id: "a", title: "alpha" },
          { id: "c", title: "gamma" },
        ]),
        {
          label: "tasks reorder and add a row",
          until: (actualRoot) => titlesAt(actualRoot).join(",") === "beta,alpha,gamma",
        },
      );
      expect(titles(root)).toEqual(["beta", "alpha", "gamma"]);

      yield* page.act(setTasks(tasks, [{ id: "c", title: "gamma" }]), {
        label: "tasks remove old rows",
        until: (actualRoot) => titlesAt(actualRoot).join(",") === "gamma",
      });
      expect(titles(root)).toEqual(["gamma"]);
    }),
  );

  it.scoped("replacing an item under one key updates that row in place", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const tasks = yield* spawn(
        Behavior.value<ReadonlyArray<Task>>([{ id: "a", title: "alpha" }]),
      );
      const page = yield* pageMount(root, TaskList, { tasks: tasks.state });
      const before = root.querySelector("li");

      yield* page.act(setTasks(tasks, [{ id: "a", title: "ALPHA" }]), {
        label: "one keyed row updates",
        until: (actualRoot) => titlesAt(actualRoot).join(",") === "ALPHA",
      });
      expect(titles(root)).toEqual(["ALPHA"]);
      expect(root.querySelector("li")).toBe(before);
    }),
  );

  it.scoped("Show adds and removes its children", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const open = yield* spawn(Behavior.value(false));
      const page = yield* pageMount(root, Toggle, { open: open.state });
      expect(root.querySelector("#body")).toBeNull();

      yield* page.act(open.call(Value.Set(true)), {
        label: "toggle opens",
        until: (actualRoot) => textAt(actualRoot, "#body") === "visible",
      });
      expect(textOf(root, "#body")).toBe("visible");

      yield* page.act(open.call(Value.Set(false)), {
        label: "toggle closes",
        until: (actualRoot) => !hasAt(actualRoot, "#body"),
      });
      expect(root.querySelector("#body")).toBeNull();
    }),
  );

  it.scoped("a parent composes a child by yielding its setup", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* pageMount(root, Parent, noProps);
      expect(textOf(root, "#child")).toBe("child");
    }),
  );

  it.scoped("Show narrows to the tested value and draws its fallback otherwise", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const hits = yield* spawn(Behavior.value<ReadonlyArray<string>>([]));
      const page = yield* pageMount(root, Hits, { hits: hits.state });
      expect(textOf(root, "#none")).toBe("no hits");
      expect(root.querySelector("#first")).toBeNull();

      yield* page.act(hits.call(Value.Set(["alpha", "beta"])), {
        label: "hits show the first result",
        until: (actualRoot) => textAt(actualRoot, "#first") === "alpha",
      });
      expect(root.querySelector("#none")).toBeNull();
      expect(textOf(root, "#first")).toBe("alpha");

      // A change that keeps the test true updates the branch in place.
      yield* page.act(hits.call(Value.Set(["gamma"])), {
        label: "hits update the kept branch",
        until: (actualRoot) => textAt(actualRoot, "#first") === "gamma",
      });
      expect(textOf(root, "#first")).toBe("gamma");

      yield* page.act(hits.call(Value.Set([])), {
        label: "empty hits show the fallback",
        until: (actualRoot) => textAt(actualRoot, "#none") === "no hits",
      });
      expect(root.querySelector("#first")).toBeNull();
      expect(textOf(root, "#none")).toBe("no hits");
    }),
  );

  it.scoped("Match draws one case per tag and updates a kept tag in place", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const job = yield* spawn(Behavior.value<Job>({ _tag: "Idle" }));
      const page = yield* pageMount(root, JobView, { job: job.state });
      expect(textOf(root, "#idle")).toBe("idle");
      expect(root.querySelector("#running")).toBeNull();

      yield* page.act(job.call(Value.Set<Job>({ _tag: "Running", percent: 10 })), {
        label: "job starts running",
        until: (actualRoot) => textAt(actualRoot, "#running") === "10%",
      });
      expect(root.querySelector("#idle")).toBeNull();
      expect(textOf(root, "#running")).toBe("10%");
      const drawn = root.querySelector("#running");

      // Same tag: the branch is kept and its binding moves.
      yield* page.act(job.call(Value.Set<Job>({ _tag: "Running", percent: 60 })), {
        label: "running job updates",
        until: (actualRoot) => textAt(actualRoot, "#running") === "60%",
      });
      expect(textOf(root, "#running")).toBe("60%");
      expect(root.querySelector("#running")).toBe(drawn);

      yield* page.act(job.call(Value.Set<Job>({ _tag: "Done", output: "ok" })), {
        label: "job completes",
        until: (actualRoot) => textAt(actualRoot, "#done") === "ok",
      });
      expect(root.querySelector("#running")).toBeNull();
      expect(textOf(root, "#done")).toBe("ok");
    }),
  );

  it.scoped("a behaviour runs once its element is in the document and ends with its branch", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      document.body.appendChild(root);
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const open = yield* spawn(Behavior.value(false));
      const attached = yield* Deferred.make<void>();
      const gone = yield* Deferred.make<void>();
      const page = yield* pageMount(root, Attaching, { open: open.state, log, attached, gone });
      expect(yield* Ref.get(log)).toEqual([]);

      yield* page.act(Effect.andThen(open.call(Value.Set(true)), Deferred.await(attached)), {
        label: "attached branch opens",
        until: (actualRoot) => hasAt(actualRoot, "#field"),
      });
      expect(yield* Ref.get(log)).toEqual(["first:true"]);
      expect(document.activeElement?.id).toBe("field");

      yield* page.act(Effect.andThen(open.call(Value.Set(false)), Deferred.await(gone)), {
        label: "attached branch closes",
        until: (actualRoot) => !hasAt(actualRoot, "#field"),
      });
      expect(yield* Ref.get(log)).toEqual(["first:true", "gone"]);
      root.remove();
    }),
  );

  it.scoped("a Portal draws under its target and leaves with its branch", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const into = document.createElement("div");
      const open = yield* spawn(Behavior.value(false));
      const page = yield* pageMount(root, WithPortal, { open: open.state, into });
      expect(into.querySelector("#modal")).toBeNull();

      yield* page.act(open.call(Value.Set(true)), {
        label: "portal opens",
        until: () => textOf(into, "#modal") === "hello",
      });
      expect(root.querySelector("#modal")).toBeNull();
      expect(textOf(into, "#modal")).toBe("hello");

      yield* page.act(open.call(Value.Set(false)), {
        label: "portal closes",
        until: () => Option.isNone(Option.fromNullishOr(into.querySelector("#modal"))),
      });
      expect(into.querySelector("#modal")).toBeNull();
    }),
  );

  it.scoped("Show accepts a type predicate and hands the branch the narrowed source", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const name = yield* spawn(Behavior.value<Option.Option<string>>(Option.none()));
      const page = yield* pageMount(root, Optional, { name: name.state });
      expect(root.querySelector("#name")).toBeNull();

      yield* page.act(name.call(Value.Set(Option.some("Ada"))), {
        label: "optional name appears",
        until: (actualRoot) => textAt(actualRoot, "#name") === "Ada",
      });
      expect(textOf(root, "#name")).toBe("Ada");

      yield* page.act(name.call(Value.Set(Option.none())), {
        label: "optional name disappears",
        until: (actualRoot) => !hasAt(actualRoot, "#name"),
      });
      expect(root.querySelector("#name")).toBeNull();
    }),
  );

  it.scoped("Show removes what a nested Show revealed in the same update", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const outer = yield* spawn(Behavior.value(true));
      const inner = yield* spawn(Behavior.value(false));
      const page = yield* pageMount(root, NestedToggle, { outer: outer.state, inner: inner.state });
      expect(root.querySelector("#title")).toBeNull();

      // The inner branch reveals and the outer branch hides in one update.
      yield* page.act(Effect.andThen(inner.call(Value.Set(true)), outer.call(Value.Set(false))), {
        label: "nested branch hides",
        until: (actualRoot) => !hasAt(actualRoot, "#title"),
      });
      expect(root.querySelector("#title")).toBeNull();

      // Showing the outer branch again draws the inner content exactly once.
      yield* page.act(outer.call(Value.Set(true)), {
        label: "nested branch reveals",
        until: (actualRoot) => textAt(actualRoot, "#title") === "t",
      });
      expect(textOf(root, "#title")).toBe("t");
      expect(root.querySelectorAll("#title").length).toBe(1);

      // The reverse order leaves nothing behind either.
      yield* page.act(Effect.andThen(outer.call(Value.Set(false)), inner.call(Value.Set(false))), {
        label: "nested branch clears",
        until: (actualRoot) => !hasAt(actualRoot, "#title"),
      });
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
      const Watched = (_props: NoProps) =>
        Effect.succeed(
          <section>
            <Show when={open.state}>
              <p id="watched">{View.bind(counted)}</p>
            </Show>
          </section>,
        );
      const page = yield* pageMount(root, Watched, noProps);
      expect(textOf(root, "#watched")).toBe("0");

      yield* page.act(open.call(Value.Set(false)), {
        label: "hidden branch closes",
        until: (actualRoot) => !hasAt(actualRoot, "#watched"),
      });
      expect(root.querySelector("#watched")).toBeNull();

      // The branch's scope is closed, so its subscription projects nothing.
      const before = reads;
      yield* page.act(count.call(Value.Set(7)), {
        label: "hidden source stays unsubscribed",
        until: (actualRoot) => !hasAt(actualRoot, "#watched"),
      });
      expect(reads).toBe(before);

      // Showing it again subscribes afresh, against the current value.
      yield* page.act(open.call(Value.Set(true)), {
        label: "hidden branch resubscribes",
        until: (actualRoot) => textAt(actualRoot, "#watched") === "7",
      });
      expect(textOf(root, "#watched")).toBe("7");
    }),
  );

  it.scoped("an event handler sends to the actor it closed over", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const handled = yield* Deferred.make<void>();
      const Echo = (_props: NoProps) =>
        Effect.succeed(
          <button
            id="say"
            onClick={View.event(() =>
              Ref.update(seen, (all) => [...all, "hi"]).pipe(
                Effect.andThen(Deferred.succeed(handled, void 0)),
              ),
            )}
          >
            say
          </button>,
        );
      const page = yield* pageMount(root, Echo, noProps);
      yield* page.act(
        Effect.sync(() => root.querySelector("#say")?.dispatchEvent(new Event("click"))),
        { label: "event reaches its actor", until: () => true },
      );
      yield* Deferred.await(handled);
      expect(yield* Ref.get(seen)).toEqual(["hi"]);
    }),
  );

  it.scoped("a multi-word event prop listens for the lowercase DOM event", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const handled = yield* Deferred.make<void>();
      const Keys = (_props: NoProps) =>
        Effect.succeed(
          <input id="keys" onKeyDown={View.event(() => Deferred.succeed(handled, void 0))} />,
        );
      const page = yield* pageMount(root, Keys, noProps);
      yield* page.act(
        Effect.sync(() => root.querySelector("#keys")?.dispatchEvent(new Event("keydown"))),
        { label: "keydown reaches its handler", until: () => true },
      );
      yield* Deferred.await(handled);
    }),
  );

  it.scoped("submit suppresses the form's own navigation before it runs", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const sent = yield* Ref.make(false);
      const handled = yield* Deferred.make<void>();
      const Form = (_props: NoProps) =>
        Effect.succeed(
          <form
            id="form"
            onSubmit={View.submit(() =>
              Ref.set(sent, true).pipe(Effect.andThen(Deferred.succeed(handled, void 0))),
            )}
          >
            <button>go</button>
          </form>,
        );
      const page = yield* pageMount(root, Form, noProps);

      const event = new Event("submit", { cancelable: true });
      yield* page.act(
        Effect.sync(() => root.querySelector("#form")?.dispatchEvent(event)),
        { label: "form submit is handled", until: () => event.defaultPrevented },
      );
      yield* Deferred.await(handled);
      expect(event.defaultPrevented).toBe(true);
      expect(yield* Ref.get(sent)).toBe(true);
    }),
  );

  it.effect("closing the mount scope runs finalizers, stops actors, and clears nodes", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const finished = yield* Ref.make(false);
      const spawned = yield* Ref.make<ReadonlyArray<LocalActorRef<number, SetValue<number>>>>([]);

      const Owned = (_props: NoProps) =>
        Effect.gen(function* () {
          const count = yield* spawn(Behavior.value(0));
          yield* Ref.update(spawned, (all) => [...all, count]);
          yield* Effect.addFinalizer(() => Ref.set(finished, true));
          return <p id="owned">owned</p>;
        });

      const scope = yield* Scope.make();
      yield* Scope.provide(mount(Owned, noProps, Dom.host, root), scope);
      expect(textOf(root, "#owned")).toBe("owned");

      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(finished)).toBe(true);
      expect(root.childNodes.length).toBe(0);

      const actors = yield* Ref.get(spawned);
      expect(actors.length).toBe(1);
      const stopped = yield* Effect.forEach(actors, (actor) =>
        Effect.flatMap(actor.send(Value.Set(1)), (handle) => handle.settled),
      );
      expect(stopped.map((settled) => settled._tag)).toEqual(["Rejected"]);
    }),
  );

  it.scoped("rolls back host nodes when initial planning defects", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      let insertions = 0;
      const host: Host<Node> = {
        ...Dom.host,
        insert: (parent, node, anchor) => {
          insertions += 1;
          if (insertions === 2) {
            Option.getOrThrow(Option.none());
          }
          Dom.host.insert(parent, node, anchor);
        },
      };
      const Broken = (_props: NoProps) =>
        Effect.succeed(
          <>
            <p>first</p>
            <p>second</p>
          </>,
        );

      const outcome = yield* Effect.exit(mount(Broken, noProps, host, root));
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(insertions).toBe(2);
      expect(root.childNodes.length).toBe(0);
    }),
  );
});

const titles = (root: HTMLElement): ReadonlyArray<string> =>
  Array.from(root.querySelectorAll("li")).map((node) => node.textContent ?? "");

const titlesAt = (root: Node): ReadonlyArray<string> => {
  if (!(root instanceof HTMLElement)) {
    return [];
  }
  return titles(root);
};

const setTasks = Effect.fn("test.setTasks")(function* (
  tasks: LocalActorRef<ReadonlyArray<Task>, SetValue<ReadonlyArray<Task>>>,
  next: ReadonlyArray<Task>,
) {
  yield* tasks.call(Value.Set(next));
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
const CountedList = (props: CountedListProps) =>
  Effect.sync(() => {
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
          {(task: Source<Task>) => <li>{View.bind(shout(task))}</li>}
        </For>
      </ul>
    );
  });

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
      const page = yield* pageMount(root, CountedList, { tasks: tasks.state, ended });
      expect(titles(root)).toEqual(["ALPHA", "BETA"]);

      // The change reaches the derived source through the row's cell.
      yield* page.act(
        setTasks(tasks, [
          { id: "a", title: "alef" },
          { id: "b", title: "beta" },
        ]),
        {
          label: "derived row source updates",
          until: (actualRoot) => titlesAt(actualRoot).join(",") === "ALEF,BETA",
        },
      );
      expect(titles(root)).toEqual(["ALEF", "BETA"]);
      expect(yield* Ref.get(ended)).toBe(0);

      // Removing a row ends exactly that row's subscription.
      yield* page.act(setTasks(tasks, [{ id: "b", title: "beta" }]), {
        label: "removed row source ends",
        until: (actualRoot) => titlesAt(actualRoot).join(",") === "BETA",
      });
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
 * binds with the module functions, and registers a finalizer in the row scope.
 */
const CountedRows = (props: CountedRowsProps) =>
  Effect.gen(function* () {
    const rows = yield* View.list({
      each: props.tasks,
      keyBy: (task: Task) => task.id,
      row: (task: Source<Task>) =>
        Effect.gen(function* () {
          const clicks = yield* Cell.make(0);
          yield* Effect.addFinalizer(() => Ref.update(props.closed, (n) => n + 1));
          return (
            <li>
              <span class="title">{View.bind(task, (value) => value.title)}</span>
              <button class="tap" onClick={View.event(() => clicks.update((n) => n + 1))}>
                {View.bind(clicks.state, String)}
              </button>
            </li>
          );
        }),
    });
    return <ul>{rows}</ul>;
  });

interface LateRowsProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
  /** The row with this id waits for the gate before it has a body. */
  readonly slow: string;
  readonly gate: Deferred.Deferred<void>;
  /** Receipts for proving the slow setup started and was interrupted. */
  readonly setupStarted: Deferred.Deferred<void>;
  readonly setupFinalized: Deferred.Deferred<void>;
}

/** One row's setup suspends: it must land in its place, not at the end. */
const LateRows = (props: LateRowsProps) =>
  Effect.gen(function* () {
    const rows = yield* View.list({
      each: props.tasks,
      keyBy: (task: Task) => task.id,
      row: (task: Source<Task>) =>
        Effect.gen(function* () {
          const current = yield* task.get;
          if (current.id === props.slow) {
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(props.setupFinalized, void 0).pipe(Effect.asVoid),
            );
            yield* Deferred.succeed(props.setupStarted, void 0);
            yield* Deferred.await(props.gate);
          }
          return <li>{View.bind(task, (value) => value.title)}</li>;
        }),
    });
    return <ul>{rows}</ul>;
  });

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
      const page = yield* pageMount(root, CountedRows, { tasks: tasks.state, closed });
      expect(titles(root)).toEqual(["alpha0", "beta0"]);

      const taps = root.querySelectorAll("button.tap");
      yield* page.act(
        Effect.sync(() => {
          taps[1]?.dispatchEvent(new Event("click"));
          taps[1]?.dispatchEvent(new Event("click"));
        }),
        {
          label: "row keeps its own click state",
          until: (actualRoot) => titlesAt(actualRoot).join(",") === "alpha0,beta2",
        },
      );
      expect(titles(root)).toEqual(["alpha0", "beta2"]);

      // Reordering keeps each row's state with its key.
      yield* page.act(
        setTasks(tasks, [
          { id: "b", title: "BETA" },
          { id: "a", title: "alpha" },
        ]),
        {
          label: "row state follows its key",
          until: (actualRoot) => titlesAt(actualRoot).join(",") === "BETA2,alpha0",
        },
      );
      expect(titles(root)).toEqual(["BETA2", "alpha0"]);
      expect(yield* Ref.get(closed)).toBe(0);

      yield* page.act(setTasks(tasks, [{ id: "a", title: "alpha" }]), {
        label: "removed row closes its scope",
        until: (actualRoot) => titlesAt(actualRoot).join(",") === "alpha0",
      });
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
      const setupStarted = yield* Deferred.make<void>();
      const setupFinalized = yield* Deferred.make<void>();
      const page = yield* pageMount(root, LateRows, {
        tasks: tasks.state,
        slow: "b",
        gate,
        setupStarted,
        setupFinalized,
      });
      yield* Deferred.await(setupStarted);
      expect(titles(root)).toEqual(["alpha", "gamma"]);

      yield* page.act(Deferred.succeed(gate, void 0), {
        label: "slow row lands in its slot",
        until: (actualRoot) => titlesAt(actualRoot).join(",") === "alpha,beta,gamma",
      });
      expect(titles(root)).toEqual(["alpha", "beta", "gamma"]);
    }),
  );

  it.scoped("closing the mount interrupts a row setup still in flight", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const gate = yield* Deferred.make<void>();
      const setupStarted = yield* Deferred.make<void>();
      const setupFinalized = yield* Deferred.make<void>();
      const tasks = yield* spawn(Behavior.value<ReadonlyArray<Task>>([{ id: "b", title: "beta" }]));
      const scope = yield* Scope.make();
      yield* Scope.provide(
        mount(
          LateRows,
          { tasks: tasks.state, slow: "b", gate, setupStarted, setupFinalized },
          Dom.host,
          root,
        ),
        scope,
      );
      yield* Deferred.await(setupStarted);
      expect(titles(root)).toEqual([]);

      yield* Scope.close(scope, Exit.void);
      // The row setup was interrupted and its finalizer ran before the gate
      // is released. The empty root is therefore a cleanup receipt.
      yield* Deferred.await(setupFinalized);
      expect(titles(root)).toEqual([]);
      yield* Deferred.succeed(gate, void 0);
      expect(titles(root)).toEqual([]);
    }),
  );
});
