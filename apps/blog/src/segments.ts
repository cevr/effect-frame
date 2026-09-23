import { Route } from "effect-frame/router";
import { Schema } from "effect";
import { reactionsBehavior } from "./behavior.js";
import { Reactions, Slug } from "./contract.js";
import { PostBody, PostIndex } from "./queries.js";

/**
 * The addresses of the Blog route tree (#25 §2): each segment's path, its
 * params, and the data it declares. No view lives here, so the views can
 * name the segments they link to and the tree can name the views.
 *
 * ```
 * chrome  /                    nothing: it adds no param
 * ├─ index  /posts             PostIndex {}
 * └─ post   /posts/:slug       PostBody {slug}, actor Reactions {slug}
 * ```
 */

export const NoParams = Schema.Struct({});
export const PostParams = Schema.Struct({ slug: Slug });
export type PostParams = Schema.Schema.Type<typeof PostParams>;

/** The blog's chrome. It adds no param, so a prerender tree needs no inputs for it. */
export const chrome = Route.segment("chrome", { path: "/", params: NoParams });

/** Every post, newest first. */
export const index = Route.child(chrome, "index", {
  path: "posts",
  params: NoParams,
  data: () => ({ posts: Route.query(PostIndex, {}) }),
});

/**
 * One post and its reactions. The route opens the reactions reference with
 * the behavior, so a heart the client mints shows at once, and the document carries its
 * snapshot, so the island starts at the revision the page was drawn at.
 */
export const post = Route.child(chrome, "post", {
  path: "posts/:slug",
  params: PostParams,
  data: ({ params }) => ({
    body: Route.query(PostBody, { slug: params.slug }),
    reactions: Route.actor(Reactions, { slug: params.slug }, { behavior: reactionsBehavior }),
  }),
});
