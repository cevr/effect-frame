import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, Behavior, Value } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { Dom, Html, Portal, Remote, Show, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Cause, Deferred, Duration, Effect, Exit, Option, Schema, Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * A Portal draws only into a target its host made. The HTML and Remote
 * hosts make none: a server render has no node outside the view to draw
 * under, so a Portal there is a defect that names the host, never a region
 * that silently draws nothing.
 */

const WithPortal = (props: { readonly into: Element }) =>
  Effect.succeed(
    <section>
      <p>page</p>
      <Portal into={Dom.target(props.into)}>
        <dialog id="modal">hello</dialog>
      </Portal>
    </section>,
  );

const isRefused = Schema.is(View.PortalTargetRefused);

/** The refusal a failed render died with, when it died with one. */
const refusal = <A, E>(exit: Exit.Exit<A, E>): Option.Option<View.PortalTargetRefused> =>
  Exit.match(exit, {
    onSuccess: () => Option.none(),
    onFailure: (cause) => Option.liftPredicate(Cause.squash(cause), isRefused),
  });

/**
 * A Portal a `Show` reveals after mount. The view's own finalizer hands the
 * exit its mount scope closed with to `closed`.
 */
const LatePortal = (props: {
  readonly open: Source<boolean>;
  readonly into: Element;
  readonly closed: Deferred.Deferred<Exit.Exit<unknown, unknown>>;
}) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer((exit) => Deferred.succeed(props.closed, exit));
    return (
      <section>
        <Show when={props.open}>
          <Portal into={Dom.target(props.into)}>
            <dialog id="modal">hello</dialog>
          </Portal>
        </Show>
      </section>
    );
  });

const Label = (props: { readonly label: Source<string> }) =>
  Effect.succeed(<p id="label">{View.bind(props.label, (label) => label)}</p>);

describe("a Portal's target", () => {
  it.effect("the HTML host refuses a Portal, naming itself and the host that made the target", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Html.renderToString(WithPortal, { into: document.createElement("aside") }),
      );
      const refused = refusal(exit);
      expect(Option.map(refused, (error) => [error.host, error.made])).toEqual(
        Option.some(["Html", "Dom"]),
      );
      expect(Option.map(refused, (error) => error.message)).toEqual(
        Option.some("the Html host cannot draw a Portal into a target the Dom host made"),
      );
    }),
  );

  it.scoped("the Remote host refuses a Portal the same way", () =>
    Effect.gen(function* () {
      const recording = Remote.recorder();
      const exit = yield* Effect.exit(
        View.mount(
          WithPortal,
          { into: document.createElement("aside") },
          recording.host,
          Remote.root,
        ),
      );
      expect(Option.map(refusal(exit), (error) => error.host)).toEqual(Option.some("Remote"));
    }),
  );

  it.scoped("the DOM host draws into a target it made", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      const into = document.createElement("aside");
      yield* View.mount(WithPortal, { into }, Dom.host, root);
      expect(into.querySelector("#modal")?.textContent).toBe("hello");
      expect(root.querySelector("#modal")).toBeNull();
    }),
  );

  it.scoped(
    "a Portal a Show reveals after mount closes its mount with the refusal, and reactivity goes on",
    () =>
      Effect.gen(function* () {
        const open = yield* Actor.local(Behavior.value(false));
        const label = yield* Actor.local(Behavior.value("before"));
        const closed = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
        const recording = Remote.recorder();
        const remoteScope = yield* Scope.make();
        yield* View.mount(
          LatePortal,
          { open: open.state, into: document.createElement("aside"), closed },
          recording.host,
          Remote.root,
        ).pipe(Scope.provide(remoteScope));

        const main = document.createElement("main");
        const other = yield* ViewTest.make({
          host: Dom.host,
          root: main,
          setup: (host, root) => View.mount(Label, { label: label.state }, host, root),
        });

        yield* open.call(Value.Set(true));
        const exit = yield* Deferred.await(closed).pipe(Effect.timeout(Duration.seconds(2)));
        expect(Option.map(refusal(exit), (error) => [error.host, error.made])).toEqual(
          Option.some(["Remote", "Dom"]),
        );

        yield* other.act(label.call(Value.Set("after")), {
          label: "another mount still follows its source",
          until: () => main.querySelector("#label")?.textContent === "after",
        });
      }),
  );
});
