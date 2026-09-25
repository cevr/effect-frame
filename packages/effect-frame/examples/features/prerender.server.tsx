import { Route } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

const org = Route.segment("org", {
  path: "/orgs/:org",
  params: Schema.Struct({ org: Schema.String }),
});
const post = Route.child(org, "post", {
  path: "posts/:post",
  params: Schema.Struct({ post: Schema.String }),
});

const OrgView = <ChildR,>(props: Route.LayoutPropsOf<typeof org, ChildR>) =>
  Effect.map(View.loading({ fallback: <p>loading</p>, content: props.outlet }), (body) => (
    <main>{body}</main>
  ));
const PostView = (props: Route.PropsOf<typeof post>) =>
  Effect.succeed(<h1>{View.bind(props.params, (params) => params.post)}</h1>);
const NotFound = () => Effect.succeed(<p>no such page</p>);

// An example's stand-ins for a real listing.
const listOrgs = Effect.succeed([{ org: "acme" }, { org: "globex" }]);
const listPosts = (orgName: string) => Effect.succeed([{ post: `${orgName}-hello` }]);
const bundleText = Effect.succeed("/* the browser bundle */");
const documentFor = (_page: Prerender.Page): Prerender.PageDocument => ({
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  rootId: "app",
  tail: "",
  end: "</body></html>",
});

// #region tree
// A prerender tree names one `Route.inputs` for each segment that adds a
// path param. A child's function runs once per parent page, receives the
// parent's params, and returns only its own.
export const Posts = Route.prerender(
  "posts",
  Route.layout(org, [Route.leaf(post, PostView)], OrgView),
  { inputs: [Route.inputs(org, listOrgs), Route.inputs(post, (parent) => listPosts(parent.org))] },
);
// #endregion tree

// #region build
// The build: every input, through the document pipeline, in AwaitAll, as
// Anonymous. It publishes a new generation with one rename.
export const buildSite = Prerender.build({
  routes: [Posts],
  notFound: NotFound,
  document: (page) => Effect.succeed(documentFor(page)),
  client: bundleText, // written once as client.js
  out: "dist/prerender",
  timeLimit: "10 seconds",
});

// The server: a built page answers before the router runs. `load` holds the
// generation it read for the calling scope, so run it in the server's scope.
// Both the fallback and the answer are apps over the `HttpServerRequest`.
export const pages = (
  router: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
) =>
  Effect.gen(function* () {
    const site = yield* Prerender.load("dist/prerender");
    return yield* Prerender.serve(site, router);
  });
// #endregion build
