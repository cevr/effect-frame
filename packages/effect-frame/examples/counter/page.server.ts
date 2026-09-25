// #region server
import { HttpServer } from "effect-frame/actor";
import type { Principal } from "effect-frame/actor/client";
import { Anonymous } from "effect-frame/actor/client";
import { redrawDocument, renderDocument, respondDocument } from "effect-frame/router";
import type { Html } from "effect-frame/view";
import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { Counter } from "./contract.js";
import { rootId } from "./document.js";
import { NotFound, routes } from "./routes.js";

// The document around the drawing. The renderer writes `<div id={rootId}>`
// between `head` and `tail`, and a refused form post's issues after `tail`.
const page: Html.Document = {
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  rootId,
  tail: "",
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
};

// Render one URL through the routes, for one principal. The route's
// constructor picks the rendering mode; nothing here names one.
export const renderPage = (url: URL, principal: Principal) =>
  renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: page,
    closeWhen: Effect.sleep("10 seconds"),
    principal,
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
    // A refused post draws its page again, for the principal that posted.
    render: redrawDocument(renderPage),
    commitWithin: HttpServer.defaultCommitWithin,
  }),
});
// #endregion server
