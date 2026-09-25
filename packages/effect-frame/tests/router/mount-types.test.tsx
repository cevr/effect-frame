import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor";
import type { QueryCache } from "effect-frame/actor/client";
import { Route, Router, hydrate, mount, NavigationBehavior } from "effect-frame/router";
import type { Location } from "effect-frame/router";
import { Dom } from "effect-frame/view";
import { Context, Effect, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * The not-found view has its own requirements. The routes need not share
 * them: routes that need an application service still accept a not-found
 * view that links home through `Router` or reads a different service.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Extra extends Context.Service<Extra, { readonly label: string }>()(
  "effect-frame/tests/router/mount-types.test/Extra",
) {}

class RouteValue extends Context.Service<RouteValue, { readonly label: string }>()(
  "effect-frame/tests/router/mount-types.test/RouteValue",
) {}

const Nothing = Schema.Struct({});

const plainSegment = Route.segment("plain", { path: "/", params: Nothing, search: Nothing });
const plain = Route.client(
  "plain",
  Route.leaf(plainSegment, () =>
    Effect.map(Effect.service(RouteValue), (value) => <p id="plain">{value.label}</p>),
  ),
);

const NotFound = (_props: { readonly url: Source<URL> }) =>
  Effect.gen(function* () {
    yield* Router;
    const extra = yield* Extra;
    return <p id="missing">{extra.label}</p>;
  });

const mountEffect = mount({
  landing: NavigationBehavior.Restore,
  traversalReadLimit: "3 seconds",
  routes: [plain],
  notFound: NotFound,
  host: Dom.host,
  root: document.createElement("main"),
});

const mountRequirements: Equals<
  Effect.Services<typeof mountEffect>,
  Extra | RouteValue | Location | Scope.Scope
> = true;

const hydrateEffect = hydrate({
  landing: NavigationBehavior.Restore,
  traversalReadLimit: "3 seconds",
  routes: [plain],
  notFound: NotFound,
  root: document.createElement("main"),
});

// `hydrate` keeps the routes' and the not-found view's requirements, as
// `mount` does, and adds the query cache its records seed.
const hydrateRequirements: Equals<
  Effect.Services<typeof hydrateEffect>,
  Extra | RouteValue | Location | QueryCache | Scope.Scope
> = true;

describe("mount types", () => {
  it.effect("keeps the not-found view's requirements beside the routes'", () =>
    Effect.sync(() => {
      expect(mountRequirements).toBe(true);
    }),
  );

  it.effect("hydrate keeps the same requirements, plus the query cache", () =>
    Effect.sync(() => {
      expect(hydrateRequirements).toBe(true);
    }),
  );
});
