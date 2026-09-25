import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, Behavior, Value, modify } from "effect-frame/actor";
import type { LocalActorRef, SetValue, Source } from "effect-frame/actor";
import { Dom, For, Portal, Show, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import type { Host } from "effect-frame/view";
import { Deferred, Effect, Exit, Option, Queue } from "effect";
import { describe, expect, it } from "effect-bun-test";

interface EventLogProps {
  readonly events: Source<ReadonlyArray<string>>;
  readonly record: (label: string) => Effect.Effect<void>;
}

interface ShowProps extends EventLogProps {
  readonly open: Source<boolean>;
}

interface Task {
  readonly id: string;
}

interface ForProps extends EventLogProps {
  readonly tasks: Source<ReadonlyArray<Task>>;
}

interface PortalProps extends EventLogProps {
  readonly open: Source<boolean>;
  readonly into: Element;
}

interface ClosingShowProps extends ShowProps {
  readonly attached: Deferred.Deferred<void>;
  readonly blocked: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly cleaned: Deferred.Deferred<void>;
  readonly branchCalls: { value: number };
}

interface ListenerReceipt {
  readonly node: Node;
  readonly name: string;
}

interface ListenerCounts {
  attached: number;
  released: number;
}

/* oxlint-disable effect/noGlobals, effect/noAsyncFunction, effect/noNewPromise, effect/noTernary, effect/noNullish -- this child process is the timer fairness boundary. */
interface SchedulerProbeResult {
  readonly timedOut: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runSchedulerProbe = (): Promise<SchedulerProbeResult> => {
  const packageUrl = new URL("../..", import.meta.url);
  const effectUrl = new URL("./node_modules/effect/dist/index.js", packageUrl);
  const domSetupUrl = new URL("./tests/view/dom-setup.ts", packageUrl);
  const viewUrl = new URL("./src/view/index.ts", packageUrl);
  const jsxRuntimeUrl = new URL("./src/view/jsx-runtime.ts", packageUrl);
  const source = `
import { Effect, Exit, Option, Scope } from ${JSON.stringify(effectUrl.href)};
import { registerDom } from ${JSON.stringify(domSetupUrl.href)};
import { Dom, View, mount } from ${JSON.stringify(viewUrl.href)};
import { jsx } from ${JSON.stringify(jsxRuntimeUrl.href)};

registerDom();
const scope = Scope.makeUnsafe();
const root = document.createElement("main");
let started = false;
const tree = jsx("button", {
  onClick: View.event(Effect.sync(() => {
      started = true;
    }).pipe(Effect.andThen(Effect.forever(Effect.yieldNow)))),
  children: "start",
});
await Effect.runPromise(View.mount(() => Effect.succeed(tree), {}, Dom.host, root).pipe(Scope.provide(scope)));
setTimeout(() => {
  console.log("timer ran");
  Effect.runSync(Scope.close(scope, Exit.void));
  console.log(JSON.stringify({ started, nodes: root.childNodes.length }));
  process.exit(0);
}, 0);
const button = Option.getOrThrow(Option.fromNullishOr(root.querySelector("button")));
button.dispatchEvent(new Event("click"));
console.log("dispatch returned");
`;
  const child = Bun.spawn([process.execPath, "--conditions=source", "--eval", source], {
    cwd: packageUrl.pathname,
    stderr: "pipe",
    stdout: "pipe",
  });
  // The fairness window opens once the child has dispatched the click, so the
  // limit measures a starved timer, not how long a fresh Bun takes to start
  // and load the source on a busy runner. Start-up has its own, wide limit.
  const startupLimit = 30_000;
  const fairnessLimit = 1000;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let deadline = setTimeout(() => expire(), startupLimit);
    const stderr = child.stderr === null ? Promise.resolve("") : new Response(child.stderr).text();
    const expire = () => {
      if (settled) return;
      settled = true;
      child.kill();
      void Promise.all([child.exited, stderr]).then(([code, err]) =>
        resolve({ timedOut: true, code, stdout, stderr: err }),
      );
    };
    const read = async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        const before = stdout.includes("dispatch returned");
        stdout += decoder.decode(chunk, { stream: true });
        if (!before && stdout.includes("dispatch returned") && !settled) {
          clearTimeout(deadline);
          deadline = setTimeout(() => expire(), fairnessLimit);
        }
      }
    };
    void Promise.all([read(), child.exited, stderr]).then(([, code, err]) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ timedOut: false, code, stdout, stderr: err });
    });
  });
};
/* oxlint-enable effect/noGlobals, effect/noAsyncFunction, effect/noNewPromise, effect/noTernary, effect/noNullish */

const ShowPage = (props: ShowProps) =>
  Effect.succeed(
    <main>
      <output id="events">{View.bind(props.events, (labels) => labels.join(","))}</output>
      <button id="sibling" onClick={View.event(props.record("sibling"))}>
        sibling
      </button>
      <Show when={props.open}>
        <button id="branch" onClick={View.event(props.record("branch"))}>
          branch
        </button>
      </Show>
    </main>,
  );

const ForPage = (props: ForProps) =>
  Effect.succeed(
    <main>
      <output id="events">{View.bind(props.events, (labels) => labels.join(","))}</output>
      <button id="sibling" onClick={View.event(props.record("sibling"))}>
        sibling
      </button>
      <For each={props.tasks} keyBy={(task) => task.id}>
        {(task) => (
          <button
            id={View.bind(task, (value) => `row-${value.id}`)}
            onClick={View.event(props.record("row"))}
          >
            row
          </button>
        )}
      </For>
    </main>,
  );

const PortalPage = (props: PortalProps) =>
  Effect.succeed(
    <main>
      <output id="events">{View.bind(props.events, (labels) => labels.join(","))}</output>
      <Show when={props.open}>
        <Portal into={props.into}>
          <button id="portal" onClick={View.event(props.record("portal"))}>
            portal
          </button>
        </Portal>
      </Show>
    </main>,
  );

const ClosingShowPage = (props: ClosingShowProps) =>
  Effect.succeed(
    <main>
      <output id="events">{View.bind(props.events, (labels) => labels.join(","))}</output>
      <button id="sibling" onClick={View.event(props.record("sibling"))}>
        sibling
      </button>
      <Show when={props.open}>
        <button
          id="branch"
          attach={Dom.attach(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(props.attached, void 0);
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(props.blocked, void 0).pipe(
                  Effect.andThen(Deferred.await(props.release)),
                  Effect.andThen(Deferred.succeed(props.cleaned, void 0)),
                ),
              );
            }),
          )}
          onClick={View.event(
            Effect.sync(() => {
              props.branchCalls.value += 1;
            }).pipe(Effect.andThen(props.record("branch"))),
          )}
        >
          branch
        </button>
      </Show>
    </main>,
  );

const listenerHost = (
  receipts: Queue.Queue<ListenerReceipt>,
  counts: ListenerCounts,
): Host<Node> => ({
  ...Dom.host,
  addEventListener: (node, name, handler) => {
    const cleanup = Dom.host.addEventListener(node, name, handler);
    counts.attached += 1;
    return () => {
      counts.released += 1;
      cleanup();
      void Queue.offerUnsafe(receipts, { node, name });
    };
  },
});

const awaitRelease = (receipts: Queue.Queue<ListenerReceipt>) =>
  Queue.take(receipts).pipe(Effect.timeout("1 second"));

const textOf = (root: Node, selector: string): string => {
  if (!(root instanceof Element)) {
    return "";
  }
  return Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(root.querySelector(selector)), (element) =>
      Option.fromNullishOr(element.textContent),
    ),
    () => "",
  );
};

const has = (root: Node, selector: string): boolean =>
  root instanceof Element && Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

const idOf = (node: Node): string => {
  if (node instanceof Element) {
    return node.id;
  }
  return "";
};

const recordWith = (
  events: LocalActorRef<ReadonlyArray<string>, SetValue<ReadonlyArray<string>>>,
  label: string,
): Effect.Effect<void> =>
  modify(events, (labels) => [...labels, label]).pipe(
    Effect.catchTag("ActorStopped", () => Effect.void),
    Effect.asVoid,
  );

describe("view listener ownership", () => {
  it.scoped("turns over Show listeners while siblings and replacement branches stay live", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const open = yield* Actor.local(Behavior.value(true));
      const events = yield* Actor.local(Behavior.value<ReadonlyArray<string>>([]));
      const receipts = yield* Queue.unbounded<ListenerReceipt>();
      const counts: ListenerCounts = { attached: 0, released: 0 };
      const host = listenerHost(receipts, counts);
      const record = (label: string) => recordWith(events, label);
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (observedHost, mountRoot) =>
          View.mount(
            ShowPage,
            { open: open.state, events: events.state, record },
            observedHost,
            mountRoot,
          ),
      });

      yield* page.waitFor({
        label: "initial Show branch",
        until: (actualRoot) => has(actualRoot, "#branch"),
      });
      expect(counts.attached).toBe(2);
      const firstBranch = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#branch")));

      yield* page.act(open.call(Value.Set(false)), {
        label: "first Show branch leaves",
        until: (actualRoot) => !has(actualRoot, "#branch"),
      });
      const firstRelease = yield* awaitRelease(receipts);
      expect(firstRelease.node).toBe(firstBranch);
      expect(counts.released).toBe(1);

      firstBranch?.dispatchEvent(new Event("click"));
      yield* page.act(
        Effect.sync(() => root.querySelector("#sibling")?.dispatchEvent(new Event("click"))),
        {
          label: "sibling remains live after branch removal",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling",
        },
      );

      yield* page.act(open.call(Value.Set(true)), {
        label: "replacement Show branch appears",
        until: (actualRoot) => has(actualRoot, "#branch"),
      });
      expect(counts.attached).toBe(3);
      const secondBranch = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#branch")));
      yield* page.act(
        Effect.sync(() => secondBranch?.dispatchEvent(new Event("click"))),
        {
          label: "replacement branch handles a click",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling,branch",
        },
      );

      yield* page.act(open.call(Value.Set(false)), {
        label: "second Show branch leaves",
        until: (actualRoot) => !has(actualRoot, "#branch"),
      });
      const secondRelease = yield* awaitRelease(receipts);
      expect(secondRelease.node).toBe(secondBranch);
      expect(counts.released).toBe(2);

      yield* page.act(open.call(Value.Set(true)), {
        label: "third Show branch appears",
        until: (actualRoot) => has(actualRoot, "#branch"),
      });
      expect(counts.attached).toBe(4);
      const thirdBranch = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#branch")));
      yield* page.act(
        Effect.sync(() => thirdBranch?.dispatchEvent(new Event("click"))),
        {
          label: "third branch handles a click",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling,branch,branch",
        },
      );

      yield* page.close;
      yield* awaitRelease(receipts);
      yield* awaitRelease(receipts);
      expect(counts.released).toBe(4);
      expect(root.childNodes).toHaveLength(0);
    }),
  );

  it.scoped("turns over For row listeners without affecting siblings", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const tasks = yield* Actor.local(Behavior.value<ReadonlyArray<Task>>([{ id: "a" }]));
      const events = yield* Actor.local(Behavior.value<ReadonlyArray<string>>([]));
      const receipts = yield* Queue.unbounded<ListenerReceipt>();
      const counts: ListenerCounts = { attached: 0, released: 0 };
      const host = listenerHost(receipts, counts);
      const record = (label: string) => recordWith(events, label);
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (observedHost, mountRoot) =>
          View.mount(
            ForPage,
            { tasks: tasks.state, events: events.state, record },
            observedHost,
            mountRoot,
          ),
      });

      yield* page.waitFor({
        label: "initial For row",
        until: (actualRoot) => has(actualRoot, "#row-a"),
      });
      expect(counts.attached).toBe(2);
      const firstRow = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#row-a")));

      yield* page.act(tasks.call(Value.Set([])), {
        label: "first For row leaves",
        until: (actualRoot) => !has(actualRoot, "#row-a"),
      });
      const firstRelease = yield* awaitRelease(receipts);
      expect(firstRelease.node).toBe(firstRow);
      expect(counts.released).toBe(1);

      firstRow?.dispatchEvent(new Event("click"));
      yield* page.act(
        Effect.sync(() => root.querySelector("#sibling")?.dispatchEvent(new Event("click"))),
        {
          label: "sibling remains live after row removal",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling",
        },
      );

      yield* page.act(tasks.call(Value.Set([{ id: "b" }])), {
        label: "replacement For row appears",
        until: (actualRoot) => has(actualRoot, "#row-b"),
      });
      expect(counts.attached).toBe(3);
      const secondRow = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#row-b")));
      yield* page.act(
        Effect.sync(() => secondRow?.dispatchEvent(new Event("click"))),
        {
          label: "replacement row handles a click",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling,row",
        },
      );

      yield* page.act(tasks.call(Value.Set([])), {
        label: "second For row leaves",
        until: (actualRoot) => !has(actualRoot, "#row-b"),
      });
      const secondRelease = yield* awaitRelease(receipts);
      expect(secondRelease.node).toBe(secondRow);
      expect(counts.released).toBe(2);

      yield* page.act(tasks.call(Value.Set([{ id: "c" }])), {
        label: "third For row appears",
        until: (actualRoot) => has(actualRoot, "#row-c"),
      });
      expect(counts.attached).toBe(4);
      const thirdRow = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#row-c")));
      yield* page.act(
        Effect.sync(() => thirdRow?.dispatchEvent(new Event("click"))),
        {
          label: "third row handles a click",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling,row,row",
        },
      );

      yield* page.close;
      yield* awaitRelease(receipts);
      yield* awaitRelease(receipts);
      expect(counts.released).toBe(4);
      expect(root.childNodes).toHaveLength(0);
    }),
  );

  it.scoped("does not start a removed handler while owner cleanup is blocked", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const open = yield* Actor.local(Behavior.value(true));
      const events = yield* Actor.local(Behavior.value<ReadonlyArray<string>>([]));
      const attached = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const receipts = yield* Queue.unbounded<ListenerReceipt>();
      const counts: ListenerCounts = { attached: 0, released: 0 };
      const branchCalls = { value: 0 };
      const host = listenerHost(receipts, counts);
      const record = (label: string) => recordWith(events, label);
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (observedHost, mountRoot) =>
          View.mount(
            ClosingShowPage,
            {
              open: open.state,
              events: events.state,
              record,
              attached,
              blocked,
              release,
              cleaned,
              branchCalls,
            },
            observedHost,
            mountRoot,
          ),
      });

      yield* page.waitFor({
        label: "initial branch and sibling",
        until: (actualRoot) => has(actualRoot, "#branch") && has(actualRoot, "#sibling"),
      });
      yield* Deferred.await(attached);
      expect(counts.attached).toBe(2);
      const oldBranch = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#branch")));

      yield* page.act(open.call(Value.Set(false)), {
        label: "branch leaves before its finalizer is released",
        until: (actualRoot) => !has(actualRoot, "#branch"),
      });
      yield* Deferred.await(blocked);
      expect(counts.released).toBe(0);

      oldBranch.dispatchEvent(new Event("click"));
      expect(branchCalls.value).toBe(0);

      yield* page.act(
        Effect.sync(() => root.querySelector("#sibling")?.dispatchEvent(new Event("click"))),
        {
          label: "sibling stays live while branch cleanup is blocked",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling",
        },
      );

      yield* Deferred.succeed(release, void 0);
      yield* Deferred.await(cleaned);
      const firstRelease = yield* awaitRelease(receipts);
      expect(firstRelease.node).toBe(oldBranch);
      expect(counts.released).toBe(1);

      oldBranch.dispatchEvent(new Event("click"));
      expect(branchCalls.value).toBe(0);

      yield* page.act(open.call(Value.Set(true)), {
        label: "replacement branch appears after cleanup",
        until: (actualRoot) => has(actualRoot, "#branch"),
      });
      expect(counts.attached).toBe(3);
      const replacementBranch = Option.getOrThrow(
        Option.fromNullishOr(root.querySelector("#branch")),
      );
      yield* page.act(
        Effect.sync(() => replacementBranch.dispatchEvent(new Event("click"))),
        {
          label: "replacement branch handles a click",
          until: (actualRoot) => textOf(actualRoot, "#events") === "sibling,branch",
        },
      );
      expect(branchCalls.value).toBe(1);

      yield* page.close;
      yield* awaitRelease(receipts);
      yield* awaitRelease(receipts);
      expect(counts.released).toBe(3);
      expect(counts.released).toBe(counts.attached);
      expect(root.childNodes).toHaveLength(0);
    }),
  );

  it.scoped("keeps timers fair while a view handler yields", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() => runSchedulerProbe());
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toEqual([
        "dispatch returned",
        "timer ran",
        '{"started":true,"nodes":0}',
      ]);
    }),
  );

  it.scoped("releases Portal listeners on branch turnover and keeps the replacement live", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const into = document.createElement("section");
      const open = yield* Actor.local(Behavior.value(false));
      const events = yield* Actor.local(Behavior.value<ReadonlyArray<string>>([]));
      const receipts = yield* Queue.unbounded<ListenerReceipt>();
      const counts: ListenerCounts = { attached: 0, released: 0 };
      const host = listenerHost(receipts, counts);
      const record = (label: string) => recordWith(events, label);
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (observedHost, mountRoot) =>
          View.mount(
            PortalPage,
            { open: open.state, into, events: events.state, record },
            observedHost,
            mountRoot,
          ),
      });

      yield* page.act(open.call(Value.Set(true)), {
        label: "portal branch appears",
        until: () => has(into, "#portal"),
      });
      expect(counts.attached).toBe(1);
      const firstPortal = Option.getOrThrow(Option.fromNullishOr(into.querySelector("#portal")));

      yield* page.act(open.call(Value.Set(false)), {
        label: "portal branch leaves",
        until: () => !has(into, "#portal"),
      });
      const firstRelease = yield* awaitRelease(receipts);
      expect(firstRelease.node).toBe(firstPortal);
      expect(counts.released).toBe(1);

      firstPortal?.dispatchEvent(new Event("click"));
      yield* page.act(open.call(Value.Set(true)), {
        label: "replacement portal appears",
        until: () => has(into, "#portal"),
      });
      expect(counts.attached).toBe(2);
      const secondPortal = Option.getOrThrow(Option.fromNullishOr(into.querySelector("#portal")));
      yield* page.act(
        Effect.sync(() => secondPortal?.dispatchEvent(new Event("click"))),
        {
          label: "replacement portal handles a click",
          until: (actualRoot) => textOf(actualRoot, "#events") === "portal",
        },
      );

      yield* page.close;
      yield* awaitRelease(receipts);
      expect(counts.released).toBe(2);
      expect(root.childNodes).toHaveLength(0);
      expect(into.childNodes).toHaveLength(0);
    }),
  );

  it.scoped("releases listeners from a failed mount, including a portal write", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const into = document.createElement("section");
      const receipts = yield* Queue.unbounded<ListenerReceipt>();
      const counts: ListenerCounts = { attached: 0, released: 0 };
      const baseHost = listenerHost(receipts, counts);
      const host: Host<Node> = {
        ...baseHost,
        insert: (parent, node, anchor) => {
          if (node instanceof Element && node.id === "after") {
            Option.getOrThrow(Option.none());
          }
          baseHost.insert(parent, node, anchor);
        },
      };
      const Broken = () =>
        Effect.succeed(
          <>
            <button id="before" onClick={View.event(Effect.void)}>
              before
            </button>
            <Portal into={into}>
              <button id="portal" onClick={View.event(Effect.void)}>
                portal
              </button>
            </Portal>
            <p id="after">after</p>
          </>,
        );

      const outcome = yield* Effect.exit(
        ViewTest.make({
          host,
          root,
          setup: (observedHost, mountRoot) => View.mount(Broken, {}, observedHost, mountRoot),
        }),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(counts.attached).toBe(2);
      const firstRelease = yield* awaitRelease(receipts);
      const secondRelease = yield* awaitRelease(receipts);
      const releasedIds = [firstRelease.node, secondRelease.node].map(idOf);
      expect(releasedIds).toContain("before");
      expect(releasedIds).toContain("portal");
      expect(counts.released).toBe(2);
      expect(root.childNodes).toHaveLength(0);
      expect(into.childNodes).toHaveLength(0);
    }),
  );
});
