import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, Behavior, QueryFailed, Value } from "effect-frame/actor";
import type { QueryFailure, QueryState, Source } from "effect-frame/actor";
import { Dom, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import type { Host, Node as ViewNode } from "effect-frame/view";
import { Effect, Option } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";

type Kind = "Loading" | "Errored";
type State = QueryState<string, QueryFailure>;

const readyState: State = { _tag: "Ready", value: "ok", stale: false };

/** The state that makes a boundary of this kind present its fallback. */
const hiddenState = (kind: Kind): State => {
  if (kind === "Loading") {
    return { _tag: "Loading" };
  }
  return {
    _tag: "Failed",
    error: QueryFailed.make({ query: "Label", detail: "error" }),
    last: Option.none(),
  };
};

/** A boundary of either kind whose content waits on `state`. */
const boundary = (
  kind: Kind,
  id: string,
  state: Source<State>,
  content: Effect.Effect<ViewNode, never, Scope.Scope>,
): Effect.Effect<ViewNode, never, Scope.Scope> => {
  if (kind === "Loading") {
    return View.loading({
      fallback: <p id={`${id}-fallback`}>{id}</p>,
      content: Effect.gen(function* () {
        yield* View.ready(state, "");
        return yield* content;
      }),
    });
  }
  return View.errored({
    fallback: () => <p id={`${id}-fallback`}>{id}</p>,
    content: Effect.gen(function* () {
      yield* View.orErrored(state);
      return yield* content;
    }),
  });
};

/**
 * The production DOM host, with every element it creates remembered by id.
 * Hidden content is built through the detached constructor, so both
 * constructors report. An id in `weak` is only held weakly, so a test can
 * observe that the runtime no longer retains that node.
 */
const recordingHost = (
  made: Map<string, Node>,
  weak: Map<string, Option.Option<WeakRef<Node>>> = new Map(),
): Host<Node> => {
  const create = (tag: string, props: Parameters<Host<Node>["createElement"]>[1]): Node => {
    const node = Dom.host.createElement(tag, props);
    Option.map(Option.fromNullishOr(props["id"]), (id) => {
      const key = String(id);
      if (weak.has(key)) {
        weak.set(key, Option.some(new WeakRef(node)));
        return;
      }
      made.set(key, node);
    });
    return node;
  };
  return { ...Dom.host, createElement: create, createDetachedElement: create };
};

const madeAt = (made: Map<string, Node>, id: string): Option.Option<Node> =>
  Option.fromNullishOr(made.get(id));

const parentIs = (made: Map<string, Node>, id: string, parent: Option.Option<Node>): boolean =>
  Option.match(madeAt(made, id), {
    onNone: () => false,
    onSome: (node) =>
      Option.match(parent, {
        onNone: () => Option.isNone(Option.fromNullishOr(node.parentNode)),
        onSome: (expected) => node.parentNode === expected,
      }),
  });

const connectedRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const root = document.createElement("main");
    document.body.appendChild(root);
    return root;
  }),
  (root) => Effect.sync(() => root.remove()),
);

/**
 * Collect on real event-loop turns until `released` holds, for at most 64
 * turns. How many turns the collector needs depends on the whole process
 * heap, including earlier test files, so a fixed count is not the property.
 * A node that stays reachable fails after the bound.
 */
const collectUntil = (released: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 64 && !released(); turn += 1) {
      // A heap observation needs a real event-loop turn between collections.
      // oxlint-disable-next-line effect/noNewPromise, effect/noGlobals -- a heap observation needs a real event-loop turn.
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      yield* Effect.sync(() => Bun.gc(true));
    }
  });

const orders: ReadonlyArray<readonly [Kind, Kind]> = [
  ["Errored", "Loading"],
  ["Loading", "Errored"],
  ["Errored", "Errored"],
];

describe("nested readiness presentation", () => {
  for (const [outerKind, innerKind] of orders) {
    const cases = [
      {
        toggleInner: false,
        name: `runs a queued attachment once when hidden ${outerKind} reveals ${innerKind} content`,
      },
      {
        toggleInner: true,
        name: `keeps a queued attachment when ${innerKind} hides and reveals inside hidden ${outerKind}`,
      },
    ];
    for (const { toggleInner, name } of cases) {
      it.scoped(name, () =>
        Effect.gen(function* () {
          const outer = yield* Actor.local(Behavior.value<State>(hiddenState(outerKind)));
          const inner = yield* Actor.local(Behavior.value<State>(readyState));
          const attached: Array<boolean> = [];
          const made = new Map<string, Node>();
          const root = yield* connectedRoot;

          const Page = () =>
            boundary(
              outerKind,
              "outer",
              outer.state,
              Effect.gen(function* () {
                const nested = yield* boundary(
                  innerKind,
                  "inner",
                  inner.state,
                  Effect.succeed(
                    <p
                      id="child"
                      attach={Dom.attach((node) =>
                        Effect.sync(() => attached.push(node.isConnected)),
                      )}
                    >
                      child
                    </p>,
                  ),
                );
                return <section id="wrapper">{nested}</section>;
              }),
            );

          const page = yield* ViewTest.make({
            host: recordingHost(made),
            root,
            setup: (host, mountRoot) => View.mount(Page, {}, host, mountRoot),
          });
          const child = Option.getOrThrow(madeAt(made, "child"));
          const wrapper = madeAt(made, "wrapper");
          expect(root.querySelector("#outer-fallback")).not.toBeNull();
          expect(parentIs(made, "child", wrapper)).toBe(true);
          expect(attached).toEqual([]);

          if (toggleInner) {
            yield* page.act(inner.call(Value.Set(hiddenState(innerKind))), {
              label: "inner hides the child inside the hidden wrapper",
              timeout: "2 seconds",
              until: () =>
                parentIs(made, "child", Option.none()) && parentIs(made, "inner-fallback", wrapper),
            });
            expect(attached).toEqual([]);
            yield* page.act(inner.call(Value.Set(readyState)), {
              label: "inner restores the same child inside the hidden wrapper",
              timeout: "2 seconds",
              until: () =>
                parentIs(made, "child", wrapper) && parentIs(made, "inner-fallback", Option.none()),
            });
            expect(attached).toEqual([]);
            expect(root.querySelector("#child")).toBeNull();
          }

          yield* page.act(outer.call(Value.Set(readyState)), {
            label: "outer reveals the same child",
            timeout: "2 seconds",
            until: () => root.querySelector("#child") === child,
          });
          expect(child.isConnected).toBe(true);
          expect(root.querySelector("#outer-fallback")).toBeNull();
          yield* page.waitFor({
            label: "the queued attachment runs",
            timeout: "2 seconds",
            until: () => attached.length > 0,
          });
          expect(attached).toEqual([true]);

          yield* page.close;
          expect(root.innerHTML).toBe("");
          expect(attached).toEqual([true]);
        }),
      );
    }
  }

  const removals = [
    { nested: false, name: "drops a queued attachment when its row ends before the first reveal" },
    {
      nested: true,
      name: "drops a queued attachment when its row ends under a visible inner boundary before reveal",
    },
  ];
  for (const { nested, name } of removals) {
    it.scoped(name, () =>
      Effect.gen(function* () {
        const outer = yield* Actor.local(Behavior.value<State>(hiddenState("Errored")));
        const inner = yield* Actor.local(Behavior.value<State>(readyState));
        const items = yield* Actor.local(Behavior.value<ReadonlyArray<string>>(["row"]));
        const attached: Array<boolean> = [];
        let rowClosed = false;
        const made = new Map<string, Node>();
        const weak = new Map<string, Option.Option<WeakRef<Node>>>([["row", Option.none()]]);
        const rowRef = (): Option.Option<WeakRef<Node>> =>
          Option.flatten(Option.fromNullishOr(weak.get("row")));
        const root = yield* connectedRoot;

        const list = View.list({
          each: items.state,
          keyBy: (id) => id,
          row: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  rowClosed = true;
                }),
              );
              return (
                <p
                  id="row"
                  attach={Dom.attach((node) => Effect.sync(() => attached.push(node.isConnected)))}
                >
                  row
                </p>
              );
            }),
        });
        const content = Effect.map(list, (rows) => <section id="wrapper">{rows}</section>);
        const withinInner = (): Effect.Effect<ViewNode, never, Scope.Scope> => {
          if (nested) {
            return boundary("Loading", "inner", inner.state, content);
          }
          return content;
        };
        const Page = () => boundary("Errored", "outer", outer.state, withinInner());

        const page = yield* ViewTest.make({
          host: recordingHost(made, weak),
          root,
          setup: (mountHost, mountRoot) => View.mount(Page, {}, mountHost, mountRoot),
        });
        const wrapper = Option.getOrThrow(madeAt(made, "wrapper"));
        yield* page.waitFor({
          label: "the row is built inside the hidden wrapper",
          timeout: "2 seconds",
          until: () => wrapper.childNodes.length === 1,
        });
        expect(Option.isSome(rowRef())).toBe(true);
        expect(root.querySelector("#outer-fallback")).not.toBeNull();

        yield* page.act(items.call(Value.Set([])), {
          label: "the row owner ends while the outer boundary is hidden",
          timeout: "2 seconds",
          until: () => wrapper.childNodes.length === 0 && rowClosed,
        });
        const liveRow = () => Option.flatMap(rowRef(), (ref) => Option.fromNullishOr(ref.deref()));
        yield* collectUntil(() => Option.isNone(liveRow()));
        expect(liveRow()).toEqual(Option.none());

        yield* page.act(outer.call(Value.Set(readyState)), {
          label: "outer reveals the empty wrapper",
          timeout: "2 seconds",
          until: () => root.querySelector("#wrapper") === wrapper,
        });
        expect(root.querySelector("#row")).toBeNull();
        expect(attached).toEqual([]);

        yield* page.close;
        expect(root.innerHTML).toBe("");
        expect(attached).toEqual([]);
      }),
    );
  }
});
