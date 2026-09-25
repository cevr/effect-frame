import { registerDom } from "./dom-setup.js";

registerDom();

import { Dom, Html, Portal, Remote, View } from "effect-frame/view";
import { Cause, Effect, Exit, Option, Schema } from "effect";
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
});
