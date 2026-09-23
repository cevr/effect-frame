import { registerDom } from "./dom-setup.js";

registerDom();

import { Location, Route, mount } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Dom, Html, ViewTest, render } from "effect-frame/view";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * #31 leaf root marking. The router makes a leaf's root element focusable
 * with `tabindex="-1"` only when the view did not write a tab index (in
 * either spelling) and the element is not focusable by the platform. The
 * server render, a hydration of it, and a fresh client render agree. See
 * `docs/design/navigation-behavior.md`.
 */

const Nothing = Schema.Struct({});
const site = Route.segment("site", { path: "/site", params: Nothing });
const own = Route.child(site, "own", { path: "own", params: Nothing });
const native = Route.child(site, "native", { path: "native", params: Nothing });
const plain = Route.child(site, "plain", { path: "plain", params: Nothing });
const childAt = (name: string) => Route.child(site, name, { path: name, params: Nothing });
const editableOff = childAt("editable-off");
const editableFalse = childAt("editable-false");
const editableInherit = childAt("editable-inherit");
const editableOn = childAt("editable-on");
const controlsOff = childAt("controls-off");
const bareAnchor = childAt("bare-anchor");

const app = Route.client(
  "site",
  Route.layout(
    site,
    [
      Route.leaf(own, () => Effect.succeed(<section id="leaf" tabIndex={0} />)),
      Route.leaf(native, () => Effect.succeed(<button id="leaf" type="button" />)),
      Route.leaf(plain, () => Effect.succeed(<section id="leaf" />)),
      Route.leaf(editableOff, () => Effect.succeed(<section id="leaf" contenteditable="false" />)),
      Route.leaf(editableFalse, () =>
        Effect.succeed(<section id="leaf" contentEditable={false} />),
      ),
      Route.leaf(editableInherit, () =>
        Effect.succeed(<section id="leaf" contenteditable="inherit" />),
      ),
      Route.leaf(editableOn, () => Effect.succeed(<section id="leaf" contenteditable="true" />)),
      Route.leaf(controlsOff, () => Effect.succeed(<video id="leaf" controls={false} />)),
      Route.leaf(bareAnchor, () => Effect.succeed(<a id="leaf">no href</a>)),
    ],
    (props) => Effect.map(props.outlet, (outlet) => <div id="layout">{outlet}</div>),
  ),
);

const NotFound = () => Effect.succeed(<p>missing</p>);

const locationAt = (href: string): LocationService => ({
  current: Effect.succeed(new URL(href)),
  push: () => Effect.void,
  replace: () => Effect.void,
  pops: Stream.never,
});

const serverHtml = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = Html.element("main");
      yield* mount({ routes: [app], notFound: NotFound, host: Html.host, root }).pipe(
        Effect.provideService(Location, locationAt(`http://site.test${path}`)),
      );
      yield* render;
      return Html.serializeChildren(root.children);
    }),
  );

const attached = (html: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const main = document.createElement("main");
      main.innerHTML = html;
      document.body.appendChild(main);
      return main;
    }),
    (main) => Effect.sync(() => main.remove()),
  );

/** The leaf root's tab index attribute, and its effective tab index. */
const rootOf = (main: HTMLElement) => {
  const leaf = main.querySelector("#leaf");
  if (!(leaf instanceof HTMLElement)) {
    return { attribute: "missing", tabIndex: Number.NaN, attributes: 0 };
  }
  const attributes = Array.from(leaf.attributes).filter(
    (attribute) => attribute.name.toLowerCase() === "tabindex",
  ).length;
  return {
    attribute: leaf.getAttribute("tabindex") ?? "none",
    tabIndex: leaf.tabIndex,
    attributes,
  };
};

const fresh = (path: string) =>
  Effect.gen(function* () {
    const main = yield* attached("");
    const page = yield* ViewTest.make({
      host: Dom.host,
      root: main,
      setup: (host, root) =>
        mount({ routes: [app], notFound: NotFound, host, root }).pipe(
          Effect.provideService(Location, locationAt(`http://site.test${path}`)),
        ),
    });
    yield* page.waitFor({
      label: "leaf shown",
      until: (actual) =>
        actual instanceof HTMLElement &&
        Option.isSome(Option.fromNullishOr(actual.querySelector("#leaf"))),
    });
    return rootOf(main);
  });

const hydrated = (path: string) =>
  Effect.gen(function* () {
    const main = yield* attached(yield* serverHtml(path));
    const hydration = Dom.hydrate(main);
    const page = yield* ViewTest.make({
      host: hydration.host,
      root: main,
      setup: (host, root) =>
        mount({ routes: [app], notFound: NotFound, host, root }).pipe(
          Effect.provideService(Location, locationAt(`http://site.test${path}`)),
        ),
    });
    yield* page.waitFor({
      label: "leaf hydrated",
      until: (actual) =>
        actual instanceof HTMLElement &&
        Option.isSome(Option.fromNullishOr(actual.querySelector("#leaf"))),
    });
    const report = yield* hydration.finish;
    return { root: rootOf(main), report };
  });

describe("leaf root", () => {
  it.scoped("an authored tabIndex is kept on the server, in hydration, and in a fresh render", () =>
    Effect.gen(function* () {
      const html = yield* serverHtml("/site/own");
      expect(html).not.toContain("-1");
      expect(html.match(/tabindex/gi)).toHaveLength(1);
      const expected = { attribute: "0", tabIndex: 0, attributes: 1 };
      expect(yield* fresh("/site/own")).toEqual(expected);
      const hydratedRoot = yield* hydrated("/site/own");
      expect(hydratedRoot.root).toEqual(expected);
      expect(hydratedRoot.report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
    }),
  );

  it.scoped("a natively focusable root keeps its place in the Tab order", () =>
    Effect.gen(function* () {
      const html = yield* serverHtml("/site/native");
      expect(html).not.toMatch(/tabindex/i);
      const expected = { attribute: "none", tabIndex: 0, attributes: 0 };
      expect(yield* fresh("/site/native")).toEqual(expected);
      expect((yield* hydrated("/site/native")).root).toEqual(expected);
    }),
  );

  it.scoped("any other root is focusable by the router and not by Tab", () =>
    Effect.gen(function* () {
      expect(yield* serverHtml("/site/plain")).toContain('tabindex="-1"');
      const expected = { attribute: "-1", tabIndex: -1, attributes: 1 };
      expect(yield* fresh("/site/plain")).toEqual(expected);
      expect((yield* hydrated("/site/plain")).root).toEqual(expected);
    }),
  );

  for (const path of [
    "/site/editable-off",
    "/site/editable-false",
    "/site/editable-inherit",
    "/site/controls-off",
    "/site/bare-anchor",
  ]) {
    it.scoped(`${path}: an attribute that does not make it focusable still gets -1`, () =>
      Effect.gen(function* () {
        expect(yield* serverHtml(path)).toContain('tabindex="-1"');
        const expected = { attribute: "-1", tabIndex: -1, attributes: 1 };
        expect(yield* fresh(path)).toEqual(expected);
        expect((yield* hydrated(path)).root).toEqual(expected);
      }),
    );
  }

  it.scoped("an editing host keeps its own Tab order", () =>
    Effect.gen(function* () {
      expect(yield* serverHtml("/site/editable-on")).not.toMatch(/tabindex/i);
      expect((yield* fresh("/site/editable-on")).attribute).toBe("none");
      expect((yield* hydrated("/site/editable-on")).root.attribute).toBe("none");
    }),
  );
});
