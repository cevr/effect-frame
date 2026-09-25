import { query } from "effect-frame/actor/client";
import { Schema } from "effect";
import { Slug } from "./contract.js";

/**
 * The three queries Blog reads (#25 §2). Browser safe: contracts only. The
 * handlers are in `posts.server.ts`. None depends on an actor: a post
 * changes when the site is built again, not when someone hearts it.
 */

/** A post as the index lists it. `date` is the ISO day it was written. */
export const PostSummary = Schema.Struct({
  slug: Slug,
  title: Schema.String,
  date: Schema.String,
});
export type PostSummary = Schema.Schema.Type<typeof PostSummary>;

/**
 * One block of a post's body. The Markdown is parsed on the server into
 * these, and the view draws each one: the view layer writes every tag
 * itself, so a post cannot put markup on the page (`blog-example.md`).
 */
export const Block = Schema.Union([
  Schema.TaggedStruct("Heading", { text: Schema.String }),
  Schema.TaggedStruct("Paragraph", { text: Schema.String }),
]);
export type Block = Schema.Schema.Type<typeof Block>;

export const PostBodyValue = Schema.Struct({
  title: Schema.String,
  date: Schema.String,
  blocks: Schema.Array(Block),
});
export type PostBodyValue = Schema.Schema.Type<typeof PostBodyValue>;

/** Every published post, newest first. The index shows it and the build enumerates it. */
export const PostIndex = query("PostIndex", {
  version: 1,
  args: Schema.Struct({}),
  result: Schema.Array(PostSummary),
  policy: "public",
  depends: [],
});

/** One post's title, date, and body. */
export const PostBody = query("PostBody", {
  version: 1,
  args: Schema.Struct({ slug: Slug }),
  result: PostBodyValue,
  policy: "public",
  depends: [],
});

/**
 * An unpublished post. Its policy, `editor`, refuses `Anonymous`, so no
 * prerendered page may read it: a route that tries fails the build
 * (`PrerenderUnauthorized`, #20, #23 §2.3).
 */
export const Draft = query("Draft", {
  version: 1,
  args: Schema.Struct({ slug: Slug }),
  result: PostBodyValue,
  policy: "editor",
  depends: [],
});
