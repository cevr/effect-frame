import { registerDom } from "./dom-setup.js";

registerDom();

import { CommandId, Form, QueryCache } from "effect-frame/actor/client";
import { Location, Route, hydrate, NavigationBehavior, memoryLocation } from "effect-frame/router";

import { Html } from "effect-frame/view";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * A page load owns the refused-form issues a document carries: `hydrate`
 * reads them and provides them to the first render, so an app writes no
 * page-load sequence of its own to redraw a refused plain post.
 */

const page = Route.segment("page", { path: "/", params: Schema.Struct({}) });

/** Draws the refused form's name when the page carried issues, and `none` otherwise. */
const IssuesView = () =>
  Effect.map(Effect.serviceOption(Form.FormContext), (found) => (
    <p id="issues">
      {Option.match(found, { onNone: () => "none", onSome: (issues) => issues.form })}
    </p>
  ));

const app = Route.ssr("page", Route.leaf(page, IssuesView));

const NotFound = () => Effect.succeed(<p id="missing">missing</p>);

const refused: Form.FormIssues = {
  contract: "notes",
  key: "a",
  form: "add",
  commandId: Schema.decodeSync(CommandId)("cmd-1"),
  outcome: "Refused",
  issues: [{ field: "text", message: "required" }],
  submitted: new Map([["text", [""]]]),
};

/** A document whose root holds what the server drew, and after it the issues script when given. */
const installDocument = (issues: Option.Option<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const main = document.createElement("main");
      main.innerHTML = `<p id="issues" tabindex="-1">${Option.match(issues, {
        onNone: () => "none",
        onSome: () => "add",
      })}</p>`;
      document.body.appendChild(main);
      document.body.insertAdjacentHTML(
        "beforeend",
        Option.match(issues, {
          onNone: () => "",
          onSome: (json) => Html.jsonScript(Form.issuesScriptId, json),
        }),
      );
      return main;
    }),
    () => Effect.sync(() => void (document.body.innerHTML = "")),
  );

const hydrated = (issues: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = yield* installDocument(issues);
    const { location } = yield* memoryLocation("http://site.test/");
    const { report } = yield* hydrate({
      landing: NavigationBehavior.Restore,
      traversalReadLimit: "3 seconds",
      routes: [app],
      notFound: NotFound,
      root,
    }).pipe(Effect.provideService(Location, location));
    return { text: root.querySelector("#issues")?.textContent, report };
  });

describe("hydrate owns the page load's form issues", () => {
  it.scoped.layer(QueryCache.layer)(
    "a page that carried a refused post draws it on the first render",
    () =>
      Effect.gen(function* () {
        const json = yield* Form.encodeIssues(refused);
        const { text, report } = yield* hydrated(Option.some(json));
        expect(text).toBe("add");
        expect(report.mismatches).toEqual([]);
      }),
  );

  it.scoped.layer(QueryCache.layer)("a page with no issues script draws without them", () =>
    Effect.gen(function* () {
      const { text, report } = yield* hydrated(Option.none());
      expect(text).toBe("none");
      expect(report.mismatches).toEqual([]);
    }),
  );
});
