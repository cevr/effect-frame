import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Actor,
  Behavior,
  Value,
  implementQuery,
  query,
  Policies,
  Policy,
  QueryCache,
} from "effect-frame/actor";
import type { QueryEntry, QueryFailure, QueryState, Source } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Dom, Html, Portal, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import type { Host } from "effect-frame/view";
import { make as makeTuiHost } from "effect-frame/view/opentui";
import type { TuiNode } from "effect-frame/view/opentui";
import { TextNodeRenderable, TextRenderable } from "@opentui/core";
import type { BaseRenderable, RenderContext } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTestRenderer } from "@opentui/core/testing";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  Scope,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const OwnershipQuery = query("ReadinessOwnership", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.String,
  depends: [],
});

type Response =
  | { readonly _tag: "Ready"; readonly value: string }
  | {
      readonly _tag: "Pending";
      readonly gate: Deferred.Deferred<void>;
      readonly value: string;
      readonly started: Option.Option<Deferred.Deferred<void>>;
    }
  | { readonly _tag: "Failed"; readonly error: string };

interface FixturesService {
  readonly responses: Ref.Ref<ReadonlyMap<string, Response>>;
}

class Fixtures extends Context.Service<Fixtures, FixturesService>()(
  "effect-frame/tests/view/readiness-ownership.test/Fixtures",
) {}

const readyDefault = (id: string): Response => ({ _tag: "Ready", value: id });

const OwnershipLive = implementQuery(OwnershipQuery, {
  run: ({ id }) =>
    Effect.gen(function* () {
      const fixtures = yield* Fixtures;
      const response = yield* Ref.get(fixtures.responses).pipe(
        Effect.map((responses): Response =>
          Option.getOrElse(Option.fromNullishOr(responses.get(id)), () => readyDefault(id)),
        ),
      );
      if (response._tag === "Pending") {
        yield* Option.match(response.started, {
          onNone: () => Effect.void,
          onSome: (started) => Deferred.succeed(started, void 0),
        });
        yield* Deferred.await(response.gate);
        const afterGate = yield* Ref.get(fixtures.responses).pipe(
          Effect.map((responses) =>
            Option.getOrElse(Option.fromNullishOr(responses.get(id)), () => response),
          ),
        );
        if (afterGate._tag === "Failed") {
          return yield* Effect.fail(afterGate.error);
        }
        return afterGate.value;
      }
      if (response._tag === "Failed") {
        return yield* Effect.fail(response.error);
      }
      return response.value;
    }),
});

const ownershipLayer = QueryTest.layer({ queries: [OwnershipLive] }).pipe(
  Layer.provide(policies),
  Layer.provideMerge(
    Layer.effect(
      Fixtures,
      Effect.map(Ref.make<ReadonlyMap<string, Response>>(new Map()), (responses) => ({
        responses,
      })),
    ),
  ),
);

const setResponse = (
  fixtures: FixturesService,
  id: string,
  response: Response,
): Effect.Effect<void> =>
  Ref.update(fixtures.responses, (responses) => {
    const next = new Map(responses);
    next.set(id, response);
    return next;
  });

const readyResponse = (value: string): Response => ({ _tag: "Ready", value });

const pendingResponse = (
  gate: Deferred.Deferred<void>,
  value: string,
  started: Option.Option<Deferred.Deferred<void>> = Option.none(),
): Response => ({ _tag: "Pending", gate, value, started });

const failedResponse = (error: string): Response => ({ _tag: "Failed", error });

const makeRoot = Effect.sync(() => document.createElement("main"));

const mountPage = <E, R>(view: View.View<Record<string, never>, E, R>, root: HTMLElement) =>
  ViewTest.make({
    host: Dom.host,
    root,
    setup: (host, mountRoot) => View.mount(view, {}, host, mountRoot),
  });

const textAt = (root: Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return Option.getOrElse(
    Option.fromNullishOr(root.querySelector(selector)?.textContent),
    () => "",
  );
};

const hasAt = (root: Node, selector: string): boolean =>
  root instanceof HTMLElement && Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

const terminalText = (node: BaseRenderable): string => {
  if (node instanceof TextNodeRenderable) {
    let text = "";
    for (const child of node.children) {
      if (Predicate.isString(child)) {
        text += child;
      } else {
        text += terminalText(child);
      }
    }
    return text;
  }
  if (node instanceof TextRenderable) {
    return node.getTextChildren().map(terminalText).join("");
  }
  return node.getChildren().map(terminalText).join("");
};

const rowPage = (
  items: Source<ReadonlyArray<string>>,
  setups: Ref.Ref<ReadonlyArray<string>>,
  closed: Ref.Ref<ReadonlyArray<string>>,
  started: Deferred.Deferred<void>,
) =>
  View.loading({
    fallback: <p id="fallback">loading</p>,
    content: Effect.gen(function* () {
      const rows = yield* View.list({
        each: items,
        keyBy: (id) => id,
        row: (item) =>
          Effect.gen(function* () {
            const id = yield* item.get;
            yield* Ref.update(setups, (all) => [...all, id]);
            yield* Deferred.succeed(started, void 0);
            yield* Effect.addFinalizer(() => Ref.update(closed, (all) => [...all, id]));
            const entry = yield* QueryCache.use((cache) => cache.open(OwnershipQuery, { id }));
            const value = yield* View.ready(entry.state, "");
            return <li id={`row-${id}`}>{View.bind(value)}</li>;
          }),
      });
      return <ul>{rows}</ul>;
    }),
  });

describe("readiness ownership", () => {
  it.scoped.layer(ownershipLayer)(
    "starts an unseeded list row under the fallback and reveals it after a real query settles",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* Fixtures;
        const queryStarted = yield* Deferred.make<void>();
        const rowSetupStarted = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const closed = yield* Ref.make<ReadonlyArray<string>>([]);
        const items = yield* Actor.local(Behavior.value<ReadonlyArray<string>>(["a"]));
        yield* setResponse(
          fixtures,
          "a",
          pendingResponse(gate, "alpha", Option.some(queryStarted)),
        );

        const page = yield* mountPage(
          () => rowPage(items.state, setups, closed, rowSetupStarted),
          root,
        );
        // The row sets up after mount; its unsettled read puts the boundary
        // in fallback before the row writes.
        yield* Deferred.await(rowSetupStarted);
        yield* Deferred.await(queryStarted);
        yield* page.waitFor({
          label: "the row's pending read shows the fallback",
          until: (actualRoot) => textAt(actualRoot, "#fallback") === "loading",
        });
        expect(root.querySelector("#row-a")).toBeNull();

        yield* setResponse(fixtures, "a", readyResponse("alpha"));
        yield* Deferred.succeed(gate, void 0);
        yield* page.waitFor({
          label: "first retained row appears",
          until: (actualRoot) => textAt(actualRoot, "#row-a") === "alpha",
        });
        expect(yield* Ref.get(setups)).toEqual(["a"]);
        expect(yield* Ref.get(closed)).toEqual([]);
      }),
  );

  it.scoped.layer(ownershipLayer)(
    "retains sibling rows across repeated pending keys and closes only the removed key",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* Fixtures;
        const rowSetupStarted = yield* Deferred.make<void>();
        const bStarted = yield* Deferred.make<void>();
        const bGate = yield* Deferred.make<void>();
        const cStarted = yield* Deferred.make<void>();
        const cGate = yield* Deferred.make<void>();
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const closed = yield* Ref.make<ReadonlyArray<string>>([]);
        const items = yield* Actor.local(Behavior.value<ReadonlyArray<string>>(["a"]));
        yield* setResponse(fixtures, "a", readyResponse("alpha"));
        yield* setResponse(fixtures, "b", pendingResponse(bGate, "beta", Option.some(bStarted)));
        yield* setResponse(fixtures, "c", pendingResponse(cGate, "gamma", Option.some(cStarted)));

        const page = yield* mountPage(
          () => rowPage(items.state, setups, closed, rowSetupStarted),
          root,
        );
        yield* page.waitFor({
          label: "initial sibling row",
          until: (actualRoot) => textAt(actualRoot, "#row-a") === "alpha",
        });
        const firstA = root.querySelector("#row-a");

        yield* items.call(Value.Set(["a", "b"]));
        yield* Deferred.await(bStarted);
        yield* page.waitFor({
          label: "first additional key puts the boundary back in fallback",
          until: (actualRoot) =>
            textAt(actualRoot, "#fallback") === "loading" && !hasAt(actualRoot, "#row-a"),
        });
        expect(yield* Ref.get(closed)).toEqual([]);

        yield* setResponse(fixtures, "b", readyResponse("beta"));
        yield* Deferred.succeed(bGate, void 0);
        yield* page.waitFor({
          label: "first additional key settles",
          until: (actualRoot) =>
            textAt(actualRoot, "#row-a") === "alpha" && textAt(actualRoot, "#row-b") === "beta",
        });
        expect(root.querySelector("#row-a")).toBe(firstA);

        yield* items.call(Value.Set(["a", "c"]));
        yield* Deferred.await(cStarted);
        yield* page.waitFor({
          label: "second additional key puts the boundary back in fallback",
          until: (actualRoot) =>
            textAt(actualRoot, "#fallback") === "loading" && !hasAt(actualRoot, "#row-a"),
        });
        expect(yield* Ref.get(closed)).toEqual(["b"]);

        yield* setResponse(fixtures, "c", readyResponse("gamma"));
        yield* Deferred.succeed(cGate, void 0);
        yield* page.waitFor({
          label: "second additional key settles",
          until: (actualRoot) =>
            textAt(actualRoot, "#row-a") === "alpha" && textAt(actualRoot, "#row-c") === "gamma",
        });
        expect(root.querySelector("#row-a")).toBe(firstA);

        yield* items.call(Value.Set(["a"]));
        yield* page.waitFor({
          label: "removed key leaves",
          until: (actualRoot) => !hasAt(actualRoot, "#row-c"),
        });
        expect(yield* Ref.get(closed)).toEqual(["b", "c"]);
        expect(yield* Ref.get(setups)).toEqual(["a", "b", "c"]);
      }),
  );

  it.scoped("interrupts a retained row setup when the root closes", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const closed = yield* Ref.make(0);
      const items: Source<ReadonlyArray<string>> = {
        get: Effect.succeed(["blocked"]),
        changes: Stream.empty,
      };
      const Page = () =>
        View.loading({
          fallback: <p id="fallback">loading</p>,
          content: Effect.gen(function* () {
            const rows = yield* View.list({
              each: items,
              keyBy: (id) => id,
              row: () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() => Ref.update(closed, (count) => count + 1));
                  yield* Deferred.succeed(started, void 0);
                  yield* Deferred.await(gate);
                  return <p id="never">never</p>;
                }),
            });
            return <>{rows}</>;
          }),
        });
      const lifetime = yield* Scope.make();
      yield* View.mount(Page, {}, Dom.host, root).pipe(Scope.provide(lifetime));
      yield* Deferred.await(started);
      // Nothing registered: the boundary shows its content, and the row is not drawn yet.
      expect(root.querySelector("#fallback")).toBeNull();
      expect(root.querySelector("#never")).toBeNull();
      yield* Scope.close(lifetime, Exit.void);
      expect(root.childNodes.length).toBe(0);
      expect(yield* Ref.get(closed)).toBe(1);
    }),
  );

  it.scoped.layer(ownershipLayer)(
    "retains a failed row owner while Errored presents its fallback",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* Fixtures;
        const entryReady = yield* Deferred.make<QueryEntry<string, QueryFailure>>();
        const setups = yield* Ref.make(0);
        const closed = yield* Ref.make(0);
        yield* setResponse(fixtures, "failed", failedResponse("boom"));
        const Page = () =>
          View.errored({
            fallback: () => <p id="error">error</p>,
            content: View.loading({
              fallback: <p id="loading">loading</p>,
              content: Effect.gen(function* () {
                const rows = yield* View.list({
                  each: {
                    get: Effect.succeed(["failed"]),
                    changes: Stream.empty,
                  },
                  keyBy: (id) => id,
                  row: () =>
                    Effect.gen(function* () {
                      yield* Ref.update(setups, (count) => count + 1);
                      yield* Effect.addFinalizer(() => Ref.update(closed, (count) => count + 1));
                      const entry = yield* QueryCache.use((cache) =>
                        cache.open(OwnershipQuery, { id: "failed" }),
                      );
                      yield* Deferred.succeed(entryReady, entry);
                      const failed = yield* View.orErrored(entry.state);
                      const value = yield* View.ready(failed, "");
                      return <p id="failed-row">{View.bind(value)}</p>;
                    }),
                });
                return <>{rows}</>;
              }),
            }),
          });
        const page = yield* mountPage(Page, root);
        yield* page.waitFor({
          label: "error fallback appears",
          until: (actualRoot) => textAt(actualRoot, "#error") === "error",
        });
        expect(yield* Ref.get(setups)).toBe(1);
        expect(yield* Ref.get(closed)).toBe(0);
        expect(root.querySelector("#failed-row")).toBeNull();

        yield* setResponse(fixtures, "failed", readyResponse("recovered"));
        const entry = yield* Deferred.await(entryReady);
        yield* entry.refresh;
        yield* page.waitFor({
          label: "failed row recovers",
          until: (actualRoot) => textAt(actualRoot, "#failed-row") === "recovered",
        });
        expect(yield* Ref.get(setups)).toBe(1);
        expect(yield* Ref.get(closed)).toBe(0);
        yield* page.close;
        expect(yield* Ref.get(closed)).toBe(1);
      }),
  );

  it.scoped.layer(ownershipLayer)(
    "withholds Portal output and attachments until insertion, then cleans both",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const target = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const created = document.createElement("aside");
            document.body.appendChild(created);
            return created;
          }),
          (created) => Effect.sync(() => created.remove()),
        );
        const fixtures = yield* Fixtures;
        const gate = yield* Deferred.make<void>();
        const queryStarted = yield* Deferred.make<void>();
        const attached = yield* Deferred.make<void>();
        const log = yield* Ref.make<ReadonlyArray<boolean>>([]);
        yield* setResponse(
          fixtures,
          "portal",
          pendingResponse(gate, "portal", Option.some(queryStarted)),
        );
        document.body.appendChild(root);
        const Page = () =>
          View.loading({
            fallback: <p id="fallback">loading</p>,
            content: Effect.gen(function* () {
              const entry = yield* QueryCache.use((cache) =>
                cache.open(OwnershipQuery, { id: "portal" }),
              );
              const value = yield* View.ready(entry.state, "");
              return (
                <Portal into={target}>
                  <p
                    id="portal"
                    attach={Dom.attach((element) =>
                      Effect.gen(function* () {
                        yield* Ref.update(log, (all) => [...all, element.isConnected]);
                        yield* Deferred.succeed(attached, void 0);
                      }),
                    )}
                  >
                    {View.bind(value)}
                  </p>
                </Portal>
              );
            }),
          });
        const page = yield* mountPage(Page, root);
        yield* Deferred.await(queryStarted);
        expect(target.querySelector("#portal")).toBeNull();
        expect(yield* Deferred.isDone(attached)).toBe(false);

        yield* setResponse(fixtures, "portal", readyResponse("portal"));
        yield* Deferred.succeed(gate, void 0);
        yield* page.waitFor({
          label: "portal is inserted",
          until: () => target.querySelector("#portal")?.textContent === "portal",
        });
        yield* Deferred.await(attached);
        expect(yield* Ref.get(log)).toEqual([true]);
        yield* page.close;
        expect(target.querySelector("#portal")).toBeNull();
      }),
  );

  it.scoped("starts an already-Ready list producer and draws it in the first HTML frame", () =>
    Effect.gen(function* () {
      let setups = 0;
      const items: Source<ReadonlyArray<string>> = {
        get: Effect.succeed(["html"]),
        changes: Stream.empty,
      };
      const state: Source<QueryState<string, string>> = {
        get: Effect.succeed({ _tag: "Ready", value: "ready", stale: false }),
        changes: Stream.empty,
      };
      const Page = () =>
        View.loading({
          fallback: <p id="fallback">loading</p>,
          content: Effect.gen(function* () {
            const rows = yield* View.list({
              each: items,
              keyBy: (id) => id,
              row: () =>
                Effect.gen(function* () {
                  setups += 1;
                  const value = yield* View.ready(state, "");
                  return <li id="html-row">{View.bind(value)}</li>;
                }),
            });
            return <ul>{rows}</ul>;
          }),
        });
      const html = yield* Html.renderToString(Page, {});
      // The marks name the boundary and the branch it drew, for hydration (#22).
      expect(html).toBe(
        '<!--frame-boundary:content--><ul><li id="html-row">ready</li></ul><!--/frame-boundary-->',
      );
      expect(setups).toBe(1);
    }),
  );

  it.scoped(
    "hydrates hidden retained content without claiming fallback or following siblings",
    () =>
      Effect.gen(function* () {
        const tags: ReadonlyArray<"section" | "p"> = ["section", "p"];
        for (const tag of tags) {
          const loadingState = yield* Actor.local(
            Behavior.value<QueryState<string, string>>({ _tag: "Loading" }),
          );
          const Page = () =>
            Effect.gen(function* () {
              const boundary = yield* View.loading({
                fallback: <p id="fallback">loading</p>,
                content: Effect.gen(function* () {
                  yield* View.ready(loadingState.state, "");
                  if (tag === "section") {
                    return <section id="hidden">secret</section>;
                  }
                  return <p id="hidden">secret</p>;
                }),
              });
              return (
                <>
                  {boundary}
                  <p id="following">following</p>
                </>
              );
            });
          const html = yield* Html.renderToString(Page, {});
          const root = yield* makeRoot;
          root.innerHTML = html;
          const fallback = root.querySelector("#fallback");
          const following = root.querySelector("#following");
          const hydration = Dom.hydrate(root);
          const page = yield* ViewTest.make({
            host: hydration.host,
            root,
            setup: (host, mountRoot) => View.mount(Page, {}, host, mountRoot),
          });
          const report = yield* hydration.finish;

          expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
          expect(root.querySelector("#fallback")).toBe(fallback);
          expect(root.querySelector("#following")).toBe(following);
          expect(root.querySelector("#hidden")).toBeNull();
          // Hydration took the boundary's marks away (#22).
          expect(root.innerHTML).toBe(
            '<p id="fallback">loading</p><p id="following">following</p>',
          );

          yield* page.act(
            loadingState.call(Value.Set({ _tag: "Ready", value: "ready", stale: false })),
            {
              label: "hydrated hidden content reveals",
              until: (actualRoot) => hasAt(actualRoot, "#hidden"),
            },
          );
          expect(root.querySelector("#fallback")).toBeNull();
          expect(root.querySelector("#following")).toBe(following);
          expect(root.querySelector("#hidden")?.nextElementSibling).toBe(following);

          yield* page.close;
        }
      }),
  );

  it.scoped("adopts visible retained content and preserves its hydrated siblings", () =>
    Effect.gen(function* () {
      const readyState: Source<QueryState<string, string>> = {
        get: Effect.succeed({ _tag: "Ready", value: "visible", stale: false }),
        changes: Stream.empty,
      };
      const Page = () =>
        Effect.gen(function* () {
          const boundary = yield* View.loading({
            fallback: <p id="fallback">loading</p>,
            content: Effect.gen(function* () {
              const value = yield* View.ready(readyState, "");
              return <section id="visible">{View.bind(value)}</section>;
            }),
          });
          return (
            <>
              {boundary}
              <p id="following">following</p>
            </>
          );
        });
      const html = yield* Html.renderToString(Page, {});
      expect(html).toBe(
        '<!--frame-boundary:content--><section id="visible">visible</section><!--/frame-boundary--><p id="following">following</p>',
      );

      const root = yield* makeRoot;
      root.innerHTML = html;
      const visible = root.querySelector("#visible");
      const following = root.querySelector("#following");
      const hydration = Dom.hydrate(root);
      const page = yield* ViewTest.make({
        host: hydration.host,
        root,
        setup: (host, mountRoot) => View.mount(Page, {}, host, mountRoot),
      });
      const report = yield* hydration.finish;

      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      expect(root.querySelector("#visible")).toBe(visible);
      expect(root.querySelector("#following")).toBe(following);
      expect(root.querySelector("#fallback")).toBeNull();
      yield* page.close;
    }),
  );

  it.scoped(
    "runs a retained pending-to-ready boundary and closes it on the headless OpenTUI host",
    () =>
      Effect.gen(function* () {
        const setup: TestRendererSetup = yield* Effect.promise(() =>
          createTestRenderer({ width: 32, height: 6 }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => setup.renderer.destroy()));
        const state = yield* Actor.local(
          Behavior.value<QueryState<string, string>>({ _tag: "Loading" }),
        );
        const Page = () =>
          Effect.gen(function* () {
            const boundary = yield* View.loading({
              fallback: <text>loading</text>,
              content: Effect.gen(function* () {
                const value = yield* View.ready(state.state, "");
                return <text>{View.bind(value)}</text>;
              }),
            });
            return <box>{boundary}</box>;
          });
        const page = yield* ViewTest.make({
          host: makeTuiHost(setup.renderer),
          root: setup.renderer.root,
          setup: (host, root) => View.mount(Page, {}, host, root),
        });
        yield* View.flush;
        yield* Effect.promise(() => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("loading");

        yield* page.act(state.call(Value.Set({ _tag: "Ready", value: "ready", stale: false })), {
          label: "OpenTUI retained content appears",
          until: (root) => terminalText(root).includes("ready"),
        });
        yield* View.flush;
        yield* Effect.promise(() => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("ready");

        yield* page.close;
        yield* View.flush;
        yield* Effect.promise(() => setup.renderOnce());
        expect(setup.captureCharFrame()).not.toContain("ready");
      }),
  );

  it.scoped("keeps the retained presentation generic over the OpenTUI Host contract", () =>
    Effect.sync(() => {
      const factory: (context: RenderContext) => Host<TuiNode> = makeTuiHost;
      expect(factory).toBe(makeTuiHost);
    }),
  );
});
