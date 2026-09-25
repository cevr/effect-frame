import { registerDom } from "./dom-setup.js";

registerDom();

import { Route } from "effect-frame/router";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * Params follow the template: a segment's codec decodes exactly the names
 * its own template declares, a child inherits its ancestors' params instead
 * of restating them, and a template with no param needs no codec.
 */

const tenant = Route.segment("tenant", {
  path: "/app/:tenant",
  params: Schema.Struct({ tenant: Schema.String }),
});

const post = Route.child(tenant, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ postId: Schema.String }),
});

const comments = Route.child(post, "comments", { path: "comments" });

const home = Route.segment("home", { path: "/" });

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type ParamsOf<Seg> = Parameters<Route.PropsOf<Seg>["href"]>[0];

/** A child's params are its ancestors' and its own, as one flat record. */
const postParams: Equals<
  ParamsOf<typeof post>,
  { readonly tenant: string; readonly postId: string }
> = true;
const commentsParams: Equals<
  ParamsOf<typeof comments>,
  { readonly tenant: string; readonly postId: string }
> = true;

// Negative fixtures: a codec that does not encode exactly the template's names.
const misnamed = Route.segment("misnamed", {
  path: "/app/:tenant",
  // @ts-expect-error The template declares tenant; the codec encodes tenantId.
  params: Schema.Struct({ tenantId: Schema.String }),
});
// @ts-expect-error The template declares a param, so params is required.
const missing = Route.segment("missing", { path: "/app/:tenant" });
const restated = Route.child(tenant, "restated", {
  path: "posts/:postId",
  // @ts-expect-error A child declares only its own params: tenant is the parent's.
  params: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
});
const extra = Route.segment("extra", {
  path: "/",
  // @ts-expect-error The template declares no param, so the codec may encode none.
  params: Schema.Struct({ id: Schema.String }),
});

describe("params follow the template", () => {
  it.effect("a child prints and parses its ancestors' params with its own", () =>
    Effect.sync(() => {
      expect(post.href({ tenant: "t1", postId: "p1" }, {})).toBe("/app/t1/posts/p1");
      expect(comments.href({ tenant: "t1", postId: "p1" }, {})).toBe("/app/t1/posts/p1/comments");
      expect(home.href({}, {})).toBe("/");
      expect([postParams, commentsParams]).toEqual([true, true]);
      expect([misnamed, missing, restated, extra].map((seg) => seg.name)).toEqual([
        "misnamed",
        "missing",
        "restated",
        "extra",
      ]);
    }),
  );
});
