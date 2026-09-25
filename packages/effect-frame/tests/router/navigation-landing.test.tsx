import { registerDom } from "./dom-setup.js";

registerDom();

import { Location, Route, Router, mount } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Dom } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Effect, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { Landing, Surface, WriteKind } from "../../src/router/landing.js";
import { registerSurface } from "../../src/router/landing.js";

/**
 * #31 landing order, without a browser. A Location with a surface records
 * each write and what its landing placed. Only the latest navigation lands:
 * a request that moves, admitted after an older one and before that one's
 * landing places, supersedes it, even when the newer request was already
 * processed. See `docs/design/navigation-behavior.md`.
 */

const Nothing = Schema.Struct({});
const site = Route.segment("site", { path: "/site", params: Nothing });
const home = Route.child(site, "home", { path: "home", params: Nothing });
const first = Route.child(site, "first", { path: "first", params: Nothing });
const second = Route.child(site, "second", { path: "second", params: Nothing });

/**
 * The first page's root asks for the second page when it is attached. A
 * behaviour runs in the flush after the shell drew: that is after `drawn`
 * and before the landing places.
 */
const FirstView = () =>
  Effect.gen(function* () {
    const router = yield* Router;
    const context = yield* Effect.context<never>();
    return (
      <section
        id="first"
        attach={Dom.attach(() =>
          Effect.sync(() => {
            Effect.runForkWith(context)(router.navigate("/site/second"));
          }).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow)),
        )}
      />
    );
  });

const app = Route.client(
  "site",
  Route.layout(
    site,
    [
      Route.leaf(home, () => Effect.succeed(<section id="home" />)),
      Route.leaf(first, FirstView),
      Route.leaf(second, () => Effect.succeed(<section id="second" />)),
    ],
    (props) => Effect.map(props.outlet, (outlet) => <div id="layout">{outlet}</div>),
  ),
);

const NotFound = () => Effect.succeed(<p>missing</p>);

/** A Location with a surface: every write, and what each write's landing placed. */
const recordingLocation = (initial: string) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const log: Array<string> = [];
    const set = (kind: WriteKind) => (url: URL) =>
      Effect.andThen(
        Ref.set(current, url),
        Effect.sync(() => {
          log.push(`${kind} ${url.pathname}`);
        }),
      );
    const service: LocationService = {
      current: Ref.get(current),
      push: set("push"),
      replace: set("replace"),
      pops: Stream.never,
    };
    const placed = (url: URL) => (landing: Option.Option<Landing>) =>
      Effect.sync(() => {
        log.push(
          `land ${url.pathname} ${Option.match(landing, { onNone: () => "none", onSome: () => "placed" })}`,
        );
      });
    const surface: Surface = {
      write: (kind, url) => Effect.as(set(kind)(url), { land: placed(url) }),
      pop: () => Effect.void,
    };
    return { service: registerSurface(service, surface), log };
  });

/** Poll a condition on the real clock. The test's own timeout bounds it. */
const until = (check: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (check()) {
      return Effect.void;
    }
    return Effect.andThen(Effect.sleep("10 millis"), until(check));
  });

describe("navigation landing order", () => {
  it.scopedLive("a newer request admitted before a landing places supersedes that landing", () =>
    Effect.gen(function* () {
      const main = document.createElement("main");
      document.body.appendChild(main);
      yield* Effect.addFinalizer(() => Effect.sync(() => main.remove()));
      const location = yield* recordingLocation("http://site.test/site/home");
      const page = yield* ViewTest.make({
        host: Dom.host,
        root: main,
        setup: (host, root) =>
          mount({ routes: [app], notFound: NotFound, host, root }).pipe(
            Effect.provideService(Location, location.service),
          ),
      });
      yield* page.setup.navigate("/site/first");
      yield* until(() => location.log.includes("land /site/second placed"));
      expect(location.log).toEqual([
        "push /site/first",
        "push /site/second",
        "land /site/first none",
        "land /site/second placed",
      ]);
    }),
  );
});
