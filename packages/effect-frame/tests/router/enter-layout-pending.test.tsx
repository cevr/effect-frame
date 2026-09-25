import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryState, Source } from "effect-frame/actor/client";
import { Location, Route, mount, NavigationBehavior, memoryLocation } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { OBSERVE } from "@solidjs/signals";
import { Effect, Option, Schema, SubscriptionRef } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * A navigation that leaves one leaf and enters a sibling layout whose first
 * read is still in flight, under a `View.loading` that already shows its
 * content (#16). The layout's setup runs as a row of the outlet's list, and
 * its unsettled `ready` holds the boundary synchronously, from inside that
 * setup. The hold writes a signal, so the setup must run outside Solid's
 * owners: Solid's development build refuses a write inside one, and the row
 * died with nothing drawn. The suites run Solid's development build, as the
 * browser bundle does, so the refusal is visible here, and the test reads
 * every diagnostic that build reports: a setup run under no owner must not
 * leave a node without one either. Both rendering modes share the runtime,
 * so both are shown.
 */

const Nothing = Schema.Struct({});
const dash = Route.segment("dash", { path: "/d", params: Nothing });
const overview = Route.child(dash, "overview", { path: "", params: Nothing });
const orders = Route.child(dash, "orders", { path: "orders", params: Nothing });
const ordersIndex = Route.child(orders, "orders-index", { path: "", params: Nothing });

type Rows = QueryState<string, never>;

/** The tree, over a read the test settles by hand. */
const tree = (mode: typeof Route.client, rows: Source<Rows>) =>
  mode(
    "dash",
    Route.layout(
      dash,
      [
        Route.leaf(overview, () => Effect.succeed(<article id="overview">overview</article>)),
        Route.layout(
          orders,
          [Route.leaf(ordersIndex, () => Effect.succeed(<ul id="detail">open orders</ul>))],
          (props) =>
            Effect.gen(function* () {
              const shown = yield* View.ready(rows, "");
              const outlet = yield* props.outlet;
              return (
                <article id="orders-page">
                  <p id="rows">{View.bind(shown)}</p>
                  {outlet}
                </article>
              );
            }),
        ),
      ],
      // The shell a reading app draws (#16, #26): `Loading` inside `Errored`.
      (props) =>
        View.errored({
          fallback: () => <p id="failure">failed</p>,
          content: View.loading({
            fallback: <p id="skeleton">loading</p>,
            content: Effect.map(props.outlet, (outlet) => <main id="outlet">{outlet}</main>),
          }),
        }),
    ),
  );

const NotFound = () => Effect.succeed(<p>missing</p>);

const textOf = (root: ParentNode, selector: string): string =>
  Option.match(Option.fromNullishOr(root.querySelector(selector)), {
    onNone: () => "",
    onSome: (node) => Option.getOrElse(Option.fromNullishOr(node.textContent), () => ""),
  });

/** Flush and poll until `check` holds, for at most two seconds. */
const settle = Effect.fn("EnterLayoutPending.settle")(function* (
  check: Effect.Effect<boolean>,
  what: string,
) {
  yield* Effect.repeat(Effect.andThen(Effect.sleep("20 millis"), View.flush), {
    while: () => Effect.map(check, (done) => !done),
    times: 100,
  });
  if (!(yield* check)) {
    return yield* Effect.die(new Error(`settle: ${what} never held`));
  }
});

const attached = Effect.acquireRelease(
  Effect.sync(() => {
    const main = document.createElement("main");
    document.body.appendChild(main);
    return main;
  }),
  (main) => Effect.sync(() => main.remove()),
);

/** Solid's diagnostics while the test runs. None: not the development build. */
const diagnostics = Effect.acquireRelease(
  Effect.sync(() =>
    Option.map(Option.fromNullishOr(OBSERVE), (observe) => observe.diagnostics.capture()),
  ),
  (capture) => Effect.sync(() => void Option.map(capture, (open) => open.stop())),
);

const modes: ReadonlyArray<readonly [string, typeof Route.client]> = [
  ["Route.client", Route.client],
  ["Route.streamed", Route.streamed],
];

describe("entering a sibling layout whose read is in flight", () => {
  for (const [name, mode] of modes) {
    it.scopedLive(`${name}: the boundary holds, then draws the layout and its index`, () =>
      Effect.gen(function* () {
        const reported = yield* diagnostics;
        const ref = yield* SubscriptionRef.make<Rows>(QueryState.Loading());
        const root = yield* attached;
        const { location } = yield* memoryLocation("http://site.test/d");
        const router = yield* mount({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes: [tree(mode, Source.fromSubscriptionRef(ref))],
          notFound: NotFound,
          host: Dom.host,
          root,
        }).pipe(Effect.provideService(Location, location));
        yield* settle(
          Effect.sync(() => textOf(root, "#overview") === "overview"),
          "the overview",
        );

        yield* router.push("/d/orders");
        // The entering layout registered unsettled: the fallback holds its place.
        yield* settle(
          Effect.sync(() => textOf(root, "#skeleton") === "loading"),
          "the held boundary",
        );
        expect(textOf(root, "#overview")).toBe("");

        yield* SubscriptionRef.set(ref, QueryState.Ready("o1 o2", false));
        yield* settle(
          Effect.sync(() => textOf(root, "#rows") === "o1 o2"),
          "the orders layout",
        );
        expect(textOf(root, "#detail")).toBe("open orders");
        expect(textOf(root, "#skeleton")).toBe("");
        expect(
          Option.match(reported, {
            onNone: () => ["not Solid's development build"],
            onSome: (capture) => capture.events.map((event) => `${event.code}: ${event.message}`),
          }),
        ).toEqual([]);
      }),
    );
  }
});
