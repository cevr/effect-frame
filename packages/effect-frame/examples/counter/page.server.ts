// #region server
import { HttpServer } from "effect-frame/actor";
import type { Principal } from "effect-frame/actor/client";
import { Anonymous, CurrentPrincipal, Form } from "effect-frame/actor/client";
import { renderDocument, respondDocument } from "effect-frame/router";
import { Html } from "effect-frame/view";
import { Effect, Option, Schema, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { Counter } from "./contract.js";
import { rootId } from "./document.js";
import { NotFound, routes } from "./routes.js";

// The document around the drawing. The renderer writes `<div id={rootId}>`
// between `head` and `tail`; a refused form post adds its issues to `tail`.
const page = (tail: string): Html.Document => ({
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  rootId,
  tail,
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
});

// Render one URL through the routes, for one principal. The route's
// constructor picks the rendering mode; nothing here names one.
export const renderPage = Effect.fn("Counter.renderPage")(function* (
  url: URL,
  principal: Principal,
) {
  // A refused post's page carries its issues, so the client draws the same form.
  const refusal = yield* Effect.serviceOption(Form.FormContext);
  const issues = yield* Option.match(refusal, {
    onNone: () => Effect.succeed(""),
    onSome: (found) =>
      Effect.map(Form.encodeIssues(found), (json) => Html.jsonScript(Form.issuesScriptId, json)),
  });
  return yield* renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: page(issues),
    closeWhen: Effect.sleep("10 seconds"),
    principal,
  });
});

// This app has no sessions: every page is drawn for nobody in particular.
const nobody: Principal = Anonymous.make({});

// A page request. `respondDocument` reads the request's URL, owns the
// render's Scope, and answers a redirect with 303, a document with its
// status, and a defect with 500.
export const answerPage = respondDocument((url) => renderPage(url, nobody), {
  onTimeout: () =>
    Effect.succeed(HttpServerResponse.text("the page took too long", { status: 504 })),
});

class PageRedirected extends Schema.TaggedError<PageRedirected>()("PageRedirected", {
  location: Schema.String,
}) {}

// The page a refused plain post draws again, as one string.
const drawAgain = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      const outcome = yield* renderPage(new URL(path, "http://counter.invalid"), principal);
      if (outcome._tag === "Redirect") {
        return yield* PageRedirected.make({ location: outcome.location.pathname });
      }
      return Array.from(yield* Stream.runCollect(outcome.body)).join("");
    }),
  );

// The actor routes: the JSON verbs, the change streams, and the plain form
// route, each at `prefix` + its path, on the app's router. Every edge
// decision is written here.
export const actors = HttpServer.layer({
  prefix: "/actors",
  principal: HttpServer.anonymous,
  maxBodyBytes: HttpServer.defaultMaxBodyBytes,
  form: Option.some({
    contracts: [Counter],
    login: Option.none(),
    render: drawAgain,
    commitWithin: HttpServer.defaultCommitWithin,
  }),
});
// #endregion server
