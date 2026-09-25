import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Location,
  Route,
  Router,
  mount as mountRouter,
  NavigationBehavior,
} from "effect-frame/router";
import { Dom } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import * as Receipt from "../../src/router/receipt.js";
import { Cause, Effect, Exit, Option, Queue, Ref, Result, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

// ---------------------------------------------------------------------------
// One gated segment, a sign-in route, and a fixture Location with pops
// ---------------------------------------------------------------------------

const origin = "http://frame.test";

const LoginSegment = Route.segment("login", {
  path: "/login",
  params: Schema.Struct({}),
  search: Route.search(Schema.Struct({})),
});
const Login = Route.client(
  "login",
  Route.leaf(LoginSegment, () => Effect.succeed(<p id="login">login</p>)),
);

const HomeSegment = Route.segment("home", {
  path: "/home",
  params: Schema.Struct({}),
  search: Route.search(Schema.Struct({})),
});
const Home = Route.client(
  "home",
  Route.leaf(HomeSegment, () => Effect.succeed(<p id="home">home</p>)),
);

const NotFound = () => Effect.succeed(<p id="not-found">not found</p>);

interface Gate {
  /** Ids whose check redirects to sign-in. */
  readonly denied: Set<string>;
  /** Every question, as `id:kind`. */
  readonly asked: Array<string>;
}

/**
 * `nav` tries to move from inside its check. `self` redirects to itself.
 * A denied id goes to sign-in.
 */
/** The gated URL that points at itself. */
const selfPath = Route.segment("self", { path: "/g/self", params: Schema.Struct({}) });

const gateSegment = Route.segment("gate-target", {
  path: "/g/:id",
  params: Schema.Struct({ id: Schema.String }),
});

const makeApp = (gate: Gate) => {
  const segment = Route.segment("gate", {
    path: "/g/:id",
    params: Schema.Struct({ id: Schema.String }),
    before: ({ params, kind }) =>
      Effect.gen(function* () {
        gate.asked.push(`${params.id}:${kind}`);
        if (params.id === "nav") {
          yield* (yield* Router).push("/home");
        }
        if (params.id === "self") {
          return Route.redirect(selfPath, {}, {});
        }
        if (gate.denied.has(params.id)) {
          return Route.redirect(LoginSegment, {}, {});
        }
        return Route.Continue;
      }),
  });
  return Route.client(
    "app",
    Route.leaf(segment, () => Effect.succeed(<p id="gate">gate</p>)),
  );
};

/** `/old/:id` only redirects: to the gated page of the same id. */
const Old = Route.redirecting(
  "old",
  Route.segment("old", { path: "/old/:id", params: Schema.Struct({ id: Schema.String }) }),
  ({ params }) => Effect.succeed(Route.redirect(gateSegment, { id: params.id }, {})),
);

const mountApp = (gate: Gate, initial: string, app: Route.AnyRoute<Router> = makeApp(gate)) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(`${origin}${initial}`));
    const pops = yield* Queue.unbounded<URL>();
    const history: Array<string> = [];
    const write = (kind: string) => (url: URL) =>
      Effect.andThen(
        Ref.set(current, url),
        Effect.sync(() => {
          history.push(`${kind} ${url.pathname}`);
        }),
      );
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => document.body.appendChild(document.createElement("main"))),
      (created) => Effect.sync(() => created.remove()),
    );
    const page = yield* ViewTest.make({
      host: Dom.host,
      root,
      setup: (host, mountRoot) =>
        mountRouter({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes: [app, Login, Home, Old],
          notFound: NotFound,
          host,
          root: mountRoot,
        }).pipe(
          Effect.provideService(Location, {
            current: Ref.get(current),
            push: write("push"),
            replace: write("replace"),
            pops: Stream.fromQueue(pops),
          }),
        ),
    });
    /** The browser moved back to `path`: the entry is current, then the pop arrives. */
    const pop = (path: string) =>
      Effect.andThen(
        Ref.set(current, new URL(`${origin}${path}`)),
        Queue.offer(pops, new URL(`${origin}${path}`)),
      );
    return { page, root, router: page.setup, receipts: Receipt.of(page.setup), history, pop };
  });

const makeGate = (denied: ReadonlyArray<string> = []): Gate => ({
  denied: new Set(denied),
  asked: [],
});

const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.match(exit, {
    onSuccess: () => "committed",
    onFailure: (cause) => Result.getOrElse(Cause.findDefect(cause), () => "no defect"),
  });

describe("route check edges", () => {
  it.scoped("a spread of a guarded route keeps its checks", () =>
    Effect.gen(function* () {
      const gate = makeGate(["deny"]);
      const guarded = makeApp(gate);
      const { receipts, history } = yield* mountApp(gate, "/home", { ...guarded });

      const receipt = yield* receipts.push("/g/deny");
      expect(receipt).toMatchObject({ _tag: "Committed" });
      expect(receipt.url.pathname).toBe("/login");
      expect(history).toEqual(["push /login"]);
      expect(gate.asked).toEqual(["deny:push"]);
    }),
  );

  it.scoped("a check that tries to move dies, and the router keeps serving", () =>
    Effect.gen(function* () {
      const gate = makeGate();
      const { receipts, history } = yield* mountApp(gate, "/login");

      const moved = yield* Effect.exit(receipts.push("/g/nav"));
      expect(moved.pipe(defectOf)).toMatchObject({ _tag: "CheckNavigation", href: "/home" });
      expect(history).toEqual([]);

      const next = yield* receipts.push("/g/ok");
      expect(next).toMatchObject({ _tag: "Committed" });
      expect(history).toEqual(["push /g/ok"]);
    }),
  );

  it.scoped("a redirected pop replaces the popped entry and publishes a pop", () =>
    Effect.gen(function* () {
      const gate = makeGate();
      const { page, router, history, pop } = yield* mountApp(gate, "/login");
      yield* Receipt.of(router).push("/g/a");
      yield* Receipt.of(router).push("/g/b");
      gate.denied.add("a");

      // Back to /g/a, which the principal has since lost.
      yield* pop("/g/a");
      yield* page.waitFor({
        label: "sign-in after the refused pop",
        until: (actual) =>
          actual instanceof HTMLElement &&
          Option.isSome(Option.fromNullishOr(actual.querySelector("#login"))),
      });
      const navigation = yield* router.navigations.get;
      expect(`${navigation.kind} ${navigation.url.pathname}`).toBe("pop /login");
      expect(history).toEqual(["push /g/a", "push /g/b", "replace /login"]);
      expect(gate.asked).toEqual(["a:push", "b:push", "a:pop"]);
    }),
  );

  it.scoped("a redirect back to the current URL is Unchanged and moves no history", () =>
    Effect.gen(function* () {
      const gate = makeGate(["deny"]);
      const { receipts, history } = yield* mountApp(gate, "/login");

      const receipt = yield* receipts.push("/g/deny");
      expect(receipt).toMatchObject({ _tag: "Unchanged" });
      expect(receipt.url.pathname).toBe("/login");
      expect(history).toEqual([]);
    }),
  );

  it.scoped("a redirecting route moves to its target, and the target's check runs", () =>
    Effect.gen(function* () {
      const gate = makeGate(["denied"]);
      const { root, receipts, history } = yield* mountApp(gate, "/login");

      const receipt = yield* receipts.push("/old/ok");
      expect(receipt).toMatchObject({ _tag: "Committed" });
      expect(receipt.url.pathname).toBe("/g/ok");
      expect(history).toEqual(["push /g/ok"]);
      expect(Option.isSome(Option.fromNullishOr(root.querySelector("#gate")))).toBe(true);

      // The target's own check still runs, and may redirect further.
      yield* receipts.push("/old/denied");
      expect(history).toEqual(["push /g/ok", "push /login"]);
      expect(gate.asked).toEqual(["ok:push", "denied:push"]);
    }),
  );

  it.scoped("a redirect cycle on the initial URL fails mount", () =>
    Effect.gen(function* () {
      const gate = makeGate();
      const mounted = yield* Effect.exit(Effect.scoped(mountApp(gate, "/g/self")));
      expect(mounted.pipe(defectOf)).toMatchObject({ _tag: "RedirectCycle", reason: "repeated" });
      expect(gate.asked[0]).toBe("self:initial");
    }),
  );
});
