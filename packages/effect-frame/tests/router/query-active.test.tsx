import {
  ActorTransport,
  Behavior,
  QueryCache,
  contract,
  implementQuery,
  implementTransparent,
  keyOf,
  query as queryContract,
  Policies,
  Policy,
  ActorHost,
} from "effect-frame/actor";
import type { QueryKey, TransportService } from "effect-frame/actor";
import { canonicalize } from "../../src/actor/canonical-json.js";
import type { FollowedQuery, QueryFailure } from "effect-frame/actor/client";
import { Location, Route, mount as mountRouter, NavigationBehavior } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Html, View } from "effect-frame/view";
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

/**
 * #28: `active` is the set a command declares, so it must be what the
 * mounted branch declares. During a transition the entering branch is
 * acquired before the exited one is released, so both are active for that
 * moment; afterwards only the current branch is, however long the session.
 */

// ---------------------------------------------------------------------------
// Contracts and a real in-process host
// ---------------------------------------------------------------------------

const Tenant = queryContract("ActiveTenant", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.String,
  depends: [],
});

const Post = queryContract("ActivePost", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
  depends: [],
});

const Comments = queryContract("ActiveComments", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
  depends: [],
});

const SetText = Schema.TaggedStruct("SetText", { text: Schema.String });
type SetText = Schema.Schema.Type<typeof SetText>;

const Draft = contract("ActiveDraft", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  snapshot: Schema.String,
  message: Schema.Union([SetText]),
});

const DraftLive = implementTransparent(Draft, {
  behavior: Behavior.reducer<string, SetText>({
    initial: "",
    reduce: (_state, message) => message.text,
  }),
});

interface Held {
  readonly gate: Deferred.Deferred<void>;
  readonly started: Deferred.Deferred<void>;
}

/** Holds one query handler or one actor snapshot read by its id, until released. */
class Holds extends Context.Service<Holds, Ref.Ref<ReadonlyMap<string, Held>>>()(
  "effect-frame/tests/router/query-active.test/Holds",
) {}

const pass = Effect.fn("ActiveTest.pass")(function* (id: string) {
  const holds = yield* Holds;
  const held = Option.fromNullishOr((yield* Ref.get(holds)).get(id));
  if (Option.isSome(held)) {
    yield* Deferred.succeed(held.value.started, void 0);
    yield* Deferred.await(held.value.gate);
  }
  return `value:${id}`;
});

const hold = Effect.fn("ActiveTest.hold")(function* (id: string) {
  const holds = yield* Holds;
  const held: Held = { gate: yield* Deferred.make<void>(), started: yield* Deferred.make<void>() };
  yield* Ref.update(holds, (all) => new Map(all).set(id, held));
  return held;
});

const TenantLive = implementQuery(Tenant, { run: ({ tenant }) => pass(`tenant:${tenant}`) });
const PostLive = implementQuery(Post, {
  run: ({ tenant, postId }) => pass(`post:${tenant}/${postId}`),
});
const CommentsLive = implementQuery(Comments, {
  run: ({ tenant, postId }) => pass(`comments:${tenant}/${postId}`),
});

const draftKey = (tenant: string, postId: string): string =>
  Schema.encodeSync(Draft.key)({ tenant, postId });

/** The host's own transport, with a snapshot read that a test can hold by actor key. */
const held = Layer.effect(
  ActorTransport,
  Effect.gen(function* () {
    const inner = yield* ActorTransport;
    const holds = yield* Holds;
    const service: TransportService = {
      ...inner,
      snapshot: (address) =>
        Effect.andThen(
          Effect.flatMap(Ref.get(holds), (all) =>
            Option.match(Option.fromNullishOr(all.get(`snapshot:${address.key}`)), {
              onNone: () => Effect.void,
              onSome: (one) =>
                Effect.andThen(Deferred.succeed(one.started, void 0), Deferred.await(one.gate)),
            }),
          ),
          inner.snapshot(address),
        ),
    };
    return service;
  }),
);

const client = Layer.merge(
  QueryCache.layer,
  ActorHost.layer({
    queries: [TenantLive, PostLive, CommentsLive],
    implementations: [DraftLive],
    store: ActorHost.memoryStore,
  }),
).pipe(Layer.provide(policies));

const testLayer = Layer.mergeAll(client, held.pipe(Layer.provide(client))).pipe(
  Layer.provideMerge(Layer.effect(Holds, Ref.make<ReadonlyMap<string, Held>>(new Map()))),
);

// ---------------------------------------------------------------------------
// The tree: a tenant layout over a post child and a pair child
// ---------------------------------------------------------------------------

const TenantParams = Schema.Struct({ tenant: Schema.String });
const tenantSegment = Route.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Route.query(Tenant, { tenant: params.tenant }) }),
});

const postSegment = Route.child(tenantSegment, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ postId: Schema.String }),
  data: ({ params }) => ({
    post: Route.query(Post, { tenant: params.tenant, postId: params.postId }),
    comments: Route.query(Comments, { tenant: params.tenant, postId: params.postId }),
  }),
});

/** Declares an actor, so its snapshot read can hold a transition open. */
const pairSegment = Route.child(tenantSegment, "pair", {
  path: "pairs/:postId",
  params: Schema.Struct({ postId: Schema.String }),
  data: ({ params }) => ({
    draft: Route.actor(Draft, { tenant: params.tenant, postId: params.postId }),
    post: Route.query(Post, { tenant: params.tenant, postId: params.postId }),
  }),
});

const app = Route.client(
  "app",
  Route.layout(
    tenantSegment,
    [
      Route.leaf(postSegment, (props) =>
        Effect.succeed(<p>{View.bind(props.params, (params) => params.postId)}</p>),
      ),
      Route.leaf(pairSegment, (props) =>
        Effect.succeed(<p>{View.bind(props.params, (params) => params.postId)}</p>),
      ),
    ],
    (props) => Effect.map(props.outlet, (outlet) => <section>{outlet}</section>),
  ),
);

const NotFound = () => Effect.succeed(<p>missing</p>);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const origin = "http://frame.test";

const mountAt = (path: string) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(`${origin}${path}`));
    const location: LocationService = {
      current: Ref.get(current),
      push: (url) => Ref.set(current, url),
      replace: (url) => Ref.set(current, url),
      pops: Stream.never,
    };
    return yield* mountRouter({
      landing: NavigationBehavior.Restore,
      traversalReadLimit: "3 seconds",
      routes: [app],
      notFound: NotFound,
      host: Html.host,
      root: Html.element("#root"),
    }).pipe(Effect.provideService(Location, location));
  });

const tenantKey = (tenant: string): QueryKey => ({
  query: Tenant.name,
  version: Tenant.version,
  args: canonicalize(Schema.encodeSync(Tenant.args)({ tenant })),
});

const postKeys = (tenant: string, postId: string): ReadonlyArray<QueryKey> =>
  [Post, Comments].map((declared) => ({
    query: declared.name,
    version: declared.version,
    args: canonicalize(Schema.encodeSync(declared.args)({ tenant, postId })),
  }));

const pairKeys = (tenant: string, postId: string): ReadonlyArray<QueryKey> => [
  {
    query: Post.name,
    version: Post.version,
    args: canonicalize(Schema.encodeSync(Post.args)({ tenant, postId })),
  },
];

const sorted = (keys: ReadonlyArray<QueryKey>): ReadonlyArray<string> => keys.map(keyOf).toSorted();

/**
 * One step of a long session. Children enter and exit, a stayed child moves
 * its param, and every tenth step moves the layout's own param, so every
 * release path runs.
 */
const stepAt = (step: number) => {
  let tenant = "t1";
  if (step % 10 === 0) {
    tenant = `t${String(step)}`;
  }
  const postId = String(step);
  if (step % 3 === 0) {
    return {
      path: `/app/${tenant}/pairs/${postId}`,
      keys: [tenantKey(tenant), ...pairKeys(tenant, postId)],
    };
  }
  return {
    path: `/app/${tenant}/posts/${postId}`,
    keys: [tenantKey(tenant), ...postKeys(tenant, postId)],
  };
};

const active = Effect.flatMap(QueryCache, (cache) => Effect.map(cache.active, sorted));

describe("#28 active follows the mounted branch", () => {
  it.scoped.layer(testLayer)("active names both branches during a transition and one after", () =>
    Effect.gen(function* () {
      const router = yield* mountAt("/app/t1/posts/1");
      expect(yield* active).toEqual(sorted([tenantKey("t1"), ...postKeys("t1", "1")]));

      // The entering pair branch holds on its actor's first snapshot, after
      // its query has been declared and its read has started.
      const snapshot = yield* hold(`snapshot:${draftKey("t1", "9")}`);
      const read = yield* hold("post:t1/9");
      const moving = yield* Effect.forkChild(router.push("/app/t1/pairs/9"));
      yield* Deferred.await(snapshot.started);
      yield* Deferred.await(read.started);

      // Mid-transition: the exited post branch and the entering pair branch.
      expect(yield* active).toEqual(
        sorted([tenantKey("t1"), ...postKeys("t1", "1"), ...pairKeys("t1", "9")]),
      );

      yield* Deferred.succeed(snapshot.gate, void 0);
      yield* Deferred.succeed(read.gate, void 0);
      yield* Fiber.join(moving);
      // After: the pair branch alone.
      expect(yield* active).toEqual(sorted([tenantKey("t1"), ...pairKeys("t1", "9")]));
    }),
  );

  it.scoped.layer(testLayer)("a session of 50 navigations declares only the current branch", () =>
    Effect.gen(function* () {
      const router = yield* mountAt("/app/t1/posts/0");
      const most = { current: 0 };
      for (let step = 1; step <= 50; step += 1) {
        const { path, keys } = stepAt(step);
        yield* router.push(path);
        const expected = sorted(keys);
        const now = yield* active;
        expect({ step, active: now }).toEqual({ step, active: expected });
        most.current = Math.max(most.current, now.length);
      }
      // The declared set never grew past one branch: a layout query and at
      // most two child queries, not 50 branches' worth.
      expect(most.current).toBe(3);
    }),
  );
});

describe("a route query binding's override (#19)", () => {
  it.scoped.layer(testLayer)("writes the entry the binding names after a stayed move", () =>
    Effect.gen(function* () {
      // The leaf hands its binding out, as a view's handler would hold it.
      const bound = yield* Ref.make(Option.none<FollowedQuery<string, QueryFailure>>());
      const overrideApp = Route.client(
        "override",
        Route.layout(
          tenantSegment,
          [
            Route.leaf(postSegment, (props) =>
              Effect.as(Ref.set(bound, Option.some(props.data.post)), <p>post</p>),
            ),
          ],
          (props) => Effect.map(props.outlet, (outlet) => <section>{outlet}</section>),
        ),
      );
      const current = yield* Ref.make(new URL(`${origin}/app/t1/posts/1`));
      const location: LocationService = {
        current: Ref.get(current),
        push: (url) => Ref.set(current, url),
        replace: (url) => Ref.set(current, url),
        pops: Stream.never,
      };
      const router = yield* mountRouter({
        landing: NavigationBehavior.Restore,
        traversalReadLimit: "3 seconds",
        routes: [overrideApp],
        notFound: NotFound,
        host: Html.host,
        root: Html.element("#root"),
      }).pipe(Effect.provideService(Location, location));
      const post = Option.getOrThrow(yield* Ref.get(bound));

      // A stayed move of the child's param: the binding now names post 2.
      yield* router.push("/app/t1/posts/2");
      const second = yield* QueryCache.use((cache) =>
        cache.open(Post, { tenant: "t1", postId: "2" }),
      );
      yield* second.state.changes.pipe(
        Stream.filter((state) => state._tag === "Ready"),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(yield* post.override(() => "guess")).toBe(true);
      expect(yield* post.state.get).toEqual({ _tag: "Ready", value: "guess", stale: true });
      expect(yield* second.state.get).toEqual({ _tag: "Ready", value: "guess", stale: true });

      // Any authoritative value replaces it.
      yield* post.refresh;
      expect(yield* post.state.get).toEqual({
        _tag: "Ready",
        value: "value:post:t1/2",
        stale: false,
      });
    }),
  );

  it.scoped.layer(testLayer)(
    "never derives the new key's value from the old key's, and writes nothing while it loads",
    () =>
      Effect.gen(function* () {
        const bound = yield* Ref.make(Option.none<FollowedQuery<string, QueryFailure>>());
        const overrideApp = Route.client(
          "override-switch",
          Route.layout(
            tenantSegment,
            [
              Route.leaf(postSegment, (props) =>
                Effect.as(Ref.set(bound, Option.some(props.data.post)), <p>post</p>),
              ),
            ],
            (props) => Effect.map(props.outlet, (outlet) => <section>{outlet}</section>),
          ),
        );
        const current = yield* Ref.make(new URL(`${origin}/app/t1/posts/1`));
        const location: LocationService = {
          current: Ref.get(current),
          push: (url) => Ref.set(current, url),
          replace: (url) => Ref.set(current, url),
          pops: Stream.never,
        };
        const router = yield* mountRouter({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes: [overrideApp],
          notFound: NotFound,
          host: Html.host,
          root: Html.element("#root"),
        }).pipe(Effect.provideService(Location, location));
        const post = Option.getOrThrow(yield* Ref.get(bound));
        yield* post.state.changes.pipe(
          Stream.filter((state) => state._tag === "Ready"),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* post.state.get).toEqual({
          _tag: "Ready",
          value: "value:post:t1/1",
          stale: false,
        });

        // Post 2's read is held: the move names post 2 while the binding
        // still shows post 1's value, carried and stale.
        const postTwo = yield* hold("post:t1/2");
        const moving = yield* Effect.forkChild(router.push("/app/t1/posts/2"));
        yield* Deferred.await(postTwo.started);
        const second = yield* QueryCache.use((cache) =>
          cache.open(Post, { tenant: "t1", postId: "2" }),
        );
        expect(yield* second.state.get).toEqual({ _tag: "Loading" });

        // The override reads post 2's own value, and it has none.
        const seen: Array<string> = [];
        const wrote = yield* post.override((value) => {
          seen.push(value);
          return `${value} (guess)`;
        });
        expect(wrote).toBe(false);
        expect(seen).toEqual([]);
        expect(yield* second.state.get).toEqual({ _tag: "Loading" });

        yield* Deferred.succeed(postTwo.gate, void 0);
        yield* Fiber.join(moving);
        yield* second.state.changes.pipe(
          Stream.filter((state) => state._tag === "Ready"),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* second.state.get).toEqual({
          _tag: "Ready",
          value: "value:post:t1/2",
          stale: false,
        });
        // Once post 2 is Ready, the override derives from post 2's value.
        expect(yield* post.override((value) => `${value} (guess)`)).toBe(true);
        expect(yield* second.state.get).toEqual({
          _tag: "Ready",
          value: "value:post:t1/2 (guess)",
          stale: true,
        });
      }),
  );
});
