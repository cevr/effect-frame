import { runQuery } from "effect-frame/actor/client";
import { Route } from "effect-frame/router";
import { Effect } from "effect";
import { PostView } from "./page.js";
import { PostIndex } from "./queries.js";
import { chrome, index, post } from "./segments.js";
import { Chrome, IndexView } from "./views.js";

/**
 * The Blog route tree (#25 §2): one prerender tree. `chrome` adds no param
 * and `index` adds none, so neither names inputs; `post` adds `slug`, and
 * its inputs are the index the index page shows. In a build the two are
 * one read (#23 §2.2). The tree is checked where it is built: a segment
 * that adds a param and names no inputs throws here.
 */

/** Every published post's slug, from the same query the index page reads. */
export const postInputs = Effect.map(runQuery(PostIndex, {}), (posts) =>
  posts.map((summary) => ({ slug: summary.slug })),
);

export const Blog = Route.prerender(
  "blog",
  Route.layout(chrome, [Route.leaf(index, IndexView), Route.leaf(post, PostView)], Chrome),
  { inputs: [Route.inputs(post, postInputs)] },
);

export const routes = [Blog];
