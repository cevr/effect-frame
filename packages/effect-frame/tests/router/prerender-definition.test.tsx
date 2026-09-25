import { Route } from "effect-frame/router";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * Prerender inputs at definition time (#23 §1, #86): `Route.prerender` is a
 * mode constructor that takes `inputs`, and a tree whose segment adds a
 * param that nothing enumerates is refused where it is constructed. See
 * `docs/design/prerender.md`.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Nothing = Schema.Struct({});
const OrgParams = Schema.Struct({ org: Schema.String });
const PostParams = Schema.Struct({ org: Schema.String, slug: Schema.String });

const view = () => Effect.succeed(<p>page</p>);

const tenant = Route.segment("tenant", { path: "/:org", params: OrgParams });
const post = Route.child(tenant, "post", { path: "posts/:slug", params: PostParams });
const blog = Route.segment("blog", { path: "/blog", params: Nothing });
const entry = Route.child(blog, "entry", {
  path: ":slug",
  params: Schema.Struct({ slug: Schema.String }),
});

// ---------------------------------------------------------------------------
// Types: inputs are required, and a child's inputs see what it inherits
// ---------------------------------------------------------------------------

/** Never called: each line is a compile-time claim. */
const typeClaims = () => {
  // @ts-expect-error -- #18 row 78: a prerender tree without its options does not compile.
  Route.prerender("no-options", Route.leaf(blog, view));
  // A child's function receives its ancestors' params and returns only its own.
  Route.inputs(post, (inherited) => {
    const org: string = inherited.org;
    return Effect.succeed([{ slug: `${org}-first` }]);
  });
  // @ts-expect-error -- a child that returns no own param does not compile.
  Route.inputs(post, () => Effect.succeed([{ org: "acme" }]));
  // @ts-expect-error -- a root's inputs return its whole params record.
  Route.inputs(tenant, Effect.succeed([{ slug: "a" }]));
};

class Store extends Schema.TaggedError<Store>()("Store", {}) {}

const tree = Route.prerender(
  "tenants",
  Route.layout(tenant, [Route.leaf(post, view)], (props) =>
    Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
  ),
  {
    inputs: [
      Route.inputs(tenant, Effect.succeed([{ org: "acme" }])),
      Route.inputs(post, ({ org }) => Effect.as(Effect.fail(Store.make({})), [{ slug: org }])),
    ],
  },
);

/** The inputs' failures reach the tree's prerender phantom, and its mounted `R` stays clean. */
const phantomClaims: ReadonlyArray<boolean> = [
  ((): Equals<Route.PrerenderError<typeof tree>, Store> => true)(),
  ((): Equals<Route.PrerenderServices<typeof tree>, never> => true)(),
];

const rejection = (declare: () => void) =>
  Effect.flip(
    Effect.try({
      try: declare,
      catch: Schema.decodeUnknownSync(
        Schema.Union([Route.PrerenderAncestorNotEnumerable, Route.PrerenderInputsRejected]),
      ),
    }),
  );

describe("prerender inputs at definition time (#23)", () => {
  it.effect(
    "prerender without inputs does not compile, and a child's inputs see its parent's",
    () =>
      Effect.sync(() => {
        expect(typeClaims).toBeInstanceOf(Function);
        expect(phantomClaims).toEqual([true, true]);
      }),
  );

  it.effect(
    "a prerender leaf under a layout that adds a param with no inputs is refused, naming the ancestor and the param",
    () =>
      Effect.gen(function* () {
        const refused = yield* rejection(
          () =>
            void Route.prerender(
              "unenumerable",
              Route.layout(tenant, [Route.leaf(post, view)], (props) =>
                Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
              ),
              {
                inputs: [Route.inputs(post, () => Effect.succeed([{ slug: "a" }]))],
              },
            ),
        );
        expect(refused).toEqual(
          Route.PrerenderAncestorNotEnumerable.make({
            route: "unenumerable",
            leaf: "post",
            ancestor: "tenant",
            param: "org",
          }),
        );
        expect(refused.message).toBe(
          'route "unenumerable" is prerender, but segment "tenant" above leaf "post" adds param `org` and names no inputs. Give "tenant" a Route.inputs, or mount "unenumerable" with another mode.',
        );
      }),
  );

  it.effect("a leaf that adds a param itself must name its inputs too", () =>
    Effect.gen(function* () {
      const refused = yield* rejection(
        () =>
          void Route.prerender(
            "no-leaf-inputs",
            Route.layout(blog, [Route.leaf(entry, view)], (props) =>
              Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
            ),
            {
              inputs: [],
            },
          ),
      );
      expect(refused).toMatchObject({ leaf: "entry", ancestor: "entry", param: "slug" });
    }),
  );

  it.effect("a prerender leaf under a layout that adds no param is allowed", () =>
    Effect.sync(() => {
      const allowed = Route.prerender(
        "chrome",
        Route.layout(blog, [Route.leaf(entry, view)], (props) =>
          Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
        ),
        { inputs: [Route.inputs(entry, () => Effect.succeed([{ slug: "hello" }]))] },
      );
      expect(allowed.name).toBe("chrome");
    }),
  );

  it.effect("inputs for a segment outside the tree, or named twice, are refused", () =>
    Effect.gen(function* () {
      const leafOnly = () => Route.leaf(entry, view);
      const cases: ReadonlyArray<readonly [string, () => void]> = [
        [
          "not in the tree",
          () =>
            void Route.prerender(
              "outside",
              Route.layout(blog, [leafOnly()], (props) =>
                Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
              ),
              {
                inputs: [
                  Route.inputs(entry, Effect.succeed([{ slug: "a" }])),
                  Route.inputs(tenant, Effect.succeed([{ org: "a" }])),
                ],
              },
            ),
        ],
        [
          "named twice",
          () =>
            void Route.prerender(
              "twice",
              Route.layout(blog, [leafOnly()], (props) =>
                Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
              ),
              {
                inputs: [
                  Route.inputs(entry, Effect.succeed([{ slug: "a" }])),
                  Route.inputs(entry, Effect.succeed([{ slug: "b" }])),
                ],
              },
            ),
        ],
      ];
      for (const [reason, declare] of cases) {
        expect(yield* rejection(declare)).toMatchObject({
          _tag: "PrerenderInputsRejected",
          reason,
        });
      }
    }),
  );
});
