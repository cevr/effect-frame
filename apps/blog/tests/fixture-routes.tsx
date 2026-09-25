import { Route } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";
import { Slug } from "../src/contract.js";
import { Draft } from "../src/queries.js";
import { PostParams } from "../src/segments.js";

/**
 * Two trees the app never mounts. Each exists to be refused: one at
 * definition, one at build.
 */

/**
 * A prerender route that reads `Draft`, whose `editor` policy refuses
 * `Anonymous`. The build must fail with `PrerenderUnauthorized` and write
 * no file (#20, #23 §2.3).
 */
export const draft = Route.segment("draft", {
  path: "/drafts/:slug",
  params: PostParams,
  data: ({ params }) => ({ draft: Route.query(Draft, { slug: params.slug }) }),
});

export const DraftRoute = Route.prerender(
  "drafts",
  Route.leaf(draft, (props) =>
    Effect.succeed(
      <article id="draft">{View.bind(props.data.draft.state, (state) => state._tag)}</article>,
    ),
  ),
  {
    inputs: [Route.inputs(draft, Effect.succeed([{ slug: Schema.decodeSync(Slug)("next-week") }]))],
  },
);

/**
 * The tree #25 §2 names: an `org` layout that adds the param `org` and
 * cannot enumerate it, over a prerender post leaf. Building it throws
 * `PrerenderAncestorNotEnumerable`. It is a function, so the throw happens
 * inside the test that calls it.
 */
export const orgSegment = Route.segment("org", {
  path: "/:org",
  params: Schema.Struct({ org: Schema.String }),
});

export const orgPost = Route.child(orgSegment, "post", {
  path: "posts/:slug",
  params: Schema.Struct({ slug: Slug }),
});

export const refusedTree = () =>
  Route.prerender(
    "org-posts",
    Route.layout(
      orgSegment,
      [Route.leaf(orgPost, () => Effect.succeed(<article id="org-post" />))],
      (props) => Effect.map(props.outlet, (outlet) => <div id="org">{outlet}</div>),
    ),
    {
      inputs: [
        Route.inputs(orgPost, () =>
          Effect.succeed([{ slug: Schema.decodeSync(Slug)("first-light") }]),
        ),
      ],
    },
  );
