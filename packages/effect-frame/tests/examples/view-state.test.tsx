import { registerDom } from "../view/dom-setup.js";

registerDom();

import { ActorHost, Policies, Policy, implementTransparent } from "effect-frame/actor";
import { Actor, QueryCache } from "effect-frame/actor/client";
import { Location, NavigationBehavior, memoryLocation, mount } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Notes, notesBehavior } from "../../examples/features/forms.js";
import { Draft, Tasks } from "../../examples/features/view-state.js";

/**
 * The README's view state (`examples/features/view-state.tsx`): a draft held
 * by a local actor and sent with `Generated.send`, and a filter and a panel
 * kept in the URL.
 */

const host = ActorHost.layer({
  implementations: [implementTransparent(Notes, { behavior: notesBehavior })],
  queries: [],
  store: ActorHost.memoryStore,
}).pipe(
  Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
  Layer.orDie,
);

const makeRoot = Effect.acquireRelease(
  Effect.sync(() => document.body.appendChild(document.createElement("main"))),
  (created) => Effect.sync(() => created.remove()),
);

const textOf = (root: globalThis.Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return root.querySelector(selector)?.textContent ?? "";
};

type Note = { readonly id: string; readonly text: string };

const NotFound = () => Effect.succeed(<p>missing</p>);

describe("the README's view state", () => {
  it.scoped.layer(Layer.merge(QueryCache.layer, host))(
    "a draft is typed into a local actor, and sent with its generated id",
    () =>
      Effect.gen(function* () {
        const notes = yield* Actor.remote(Notes, { list: "home" });
        const root = yield* makeRoot;
        const page = yield* ViewTest.make({
          host: Dom.host,
          root,
          setup: (domHost, mountRoot) => View.mount(Draft, { notes }, domHost, mountRoot),
        });
        const input = Option.getOrThrow(
          Option.fromNullishOr(root.querySelector<HTMLInputElement>("input")),
        );
        const button = Option.getOrThrow(
          Option.fromNullishOr(root.querySelector<HTMLButtonElement>("button")),
        );
        expect(button.disabled).toBe(true);
        yield* page.act(
          Effect.sync(() => {
            input.value = "milk";
            input.dispatchEvent(new Event("input"));
          }),
          { label: "the draft enables add", until: () => !button.disabled },
        );
        yield* page.act(
          Effect.sync(() => {
            root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
          }),
          { label: "the draft empties", until: () => input.value === "" },
        );
        // The send returns at once; the note lands when the actor applies it.
        const sent = yield* Stream.runHead(
          Stream.filter(notes.state.changes, (list) => list.length > 0),
        ).pipe(Effect.map(Option.getOrElse((): ReadonlyArray<Note> => [])));
        expect(sent.map((note) => note.text)).toEqual(["milk"]);
        expect(sent[0]?.id.length).toBeGreaterThan(0);
      }),
  );

  it.scoped("a search move takes a value or an updater; a UrlState claims its own key", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const memory = yield* memoryLocation("http://app.test/tasks");
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (domHost, mountRoot) =>
          mount({
            landing: NavigationBehavior.Restore,
            traversalReadLimit: "3 seconds",
            routes: [Tasks],
            notFound: NotFound,
            host: domHost,
            root: mountRoot,
          }).pipe(Effect.provideService(Location, memory.location)),
      });
      const click = (id: string, label: string, until: (node: globalThis.Node) => boolean) =>
        page.act(
          Effect.sync(() => root.querySelector(`#${id}`)?.dispatchEvent(new Event("click"))),
          { label, until },
        );
      expect(textOf(root, "#filter")).toBe("all");
      yield* click("open", "filter open", (node) => textOf(node, "#filter") === "open");
      yield* click("details", "panel open", (node) => textOf(node, "#panel") === "open");
      yield* click("all", "filter all", (node) => textOf(node, "#filter") === "all");
      expect(yield* memory.history).toEqual([
        "replace /tasks?filter=open",
        "push /tasks?filter=open&panel=open",
        "push /tasks?panel=open",
      ]);
    }),
  );
});
