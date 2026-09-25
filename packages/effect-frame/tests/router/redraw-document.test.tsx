import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorHost,
  Anonymous,
  Authenticated,
  CommandId,
  CurrentPrincipal,
  Form,
  Policies,
  QueryCache,
} from "effect-frame/actor";
import type { Principal } from "effect-frame/actor";
import { Route, redrawDocument, renderDocument } from "effect-frame/router";
import type { DocumentOutcome } from "effect-frame/router";
import { Html } from "effect-frame/view";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * A refused plain post draws its page again. The router owns that redraw:
 * `renderDocument` writes the refusal's issues beside the markup, and
 * `redrawDocument` turns a document render into the one string the form
 * route answers, so an app writes no redraw of its own.
 */

const page = Route.segment("page", { path: "/", params: Schema.Struct({}) });

const app = Route.ssr(
  "page",
  Route.leaf(page, () => Effect.succeed(<p id="page">page</p>)),
);

const routes: ReadonlyArray<Route.AnyRoute<never>> = [app];

const NotFound = () => Effect.succeed(<p id="missing">missing</p>);

const frame: Html.Document = {
  head: "<html><body>",
  rootId: "app",
  tail: "<!--tail-->",
  bootstrap: "",
  end: "</body></html>",
};

const host = Layer.build(
  Layer.merge(
    QueryCache.layer,
    ActorHost.layer<never>({ implementations: [], store: ActorHost.memoryStore }),
  ).pipe(Layer.provide(Layer.succeed(Policies, Policies.of({}))), Layer.orDie),
);

const render = (url: URL, principal: Principal) =>
  renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: frame,
    closeWhen: Effect.sleep("5 seconds"),
    principal,
  });

const refused: Form.FormIssues = {
  contract: "notes",
  key: "a",
  form: "add",
  commandId: Schema.decodeSync(CommandId)("cmd-1"),
  outcome: "Refused",
  issues: [{ field: "text", message: "required" }],
  submitted: new Map([["text", [""]]]),
};

const bodyOf = (outcome: DocumentOutcome<unknown>) => {
  if (outcome._tag === "Redirect") {
    return Effect.die("a redirect, not a document");
  }
  return Effect.map(Stream.runCollect(outcome.body), (chunks) => Array.from(chunks).join(""));
};

describe("the router redraws a refused plain post", () => {
  it.scoped("renderDocument writes the refusal's issues after the tail", () =>
    Effect.gen(function* () {
      const context = yield* host;
      const outcome = yield* render(new URL("http://site.test/"), Anonymous.make({})).pipe(
        Effect.provideService(Form.FormContext, refused),
        Effect.provideContext(context),
      );
      const body = yield* bodyOf(outcome);
      const json = yield* Form.encodeIssues(refused);
      expect(body).toContain(`<!--tail-->${Html.jsonScript(Form.issuesScriptId, json)}`);
    }),
  );

  it.scoped("a document with no refusal carries no issues script", () =>
    Effect.gen(function* () {
      const context = yield* host;
      const outcome = yield* render(new URL("http://site.test/"), Anonymous.make({})).pipe(
        Effect.provideContext(context),
      );
      expect(yield* bodyOf(outcome)).not.toContain(Form.issuesScriptId);
    }),
  );

  it.scoped("redrawDocument answers the whole document, drawn for the posting principal", () =>
    Effect.gen(function* () {
      const context = yield* host;
      const poster = Authenticated.make({ subject: "user:ada", claims: {} });
      const seen: Array<Principal> = [];
      const redraw = redrawDocument((url, principal) => {
        seen.push(principal);
        return render(url, principal);
      });
      const body = yield* redraw(new URL("http://site.test/")).pipe(
        Effect.provideService(CurrentPrincipal, poster),
        Effect.provideService(Form.FormContext, refused),
        Effect.provideContext(context),
      );
      expect(seen).toEqual([poster]);
      expect(body.startsWith("<html><body>")).toBe(true);
      expect(body).toContain('<p id="page" tabindex="-1">page</p>');
      expect(body).toContain(Form.issuesScriptId);
      expect(body.endsWith("</body></html>")).toBe(true);
    }),
  );

  it.effect("a redirect fails the redraw with DocumentRedirected, naming the path and search", () =>
    Effect.gen(function* () {
      const redraw = redrawDocument(() =>
        Effect.succeed<DocumentOutcome<never>>({
          _tag: "Redirect",
          location: new URL("http://site.test/login?next=%2F"),
        }),
      );
      const error = yield* Effect.flip(
        redraw(new URL("http://site.test/")).pipe(
          Effect.provideService(CurrentPrincipal, Anonymous.make({})),
        ),
      );
      expect(error).toMatchObject({ _tag: "DocumentRedirected", location: "/login?next=%2F" });
    }),
  );
});
