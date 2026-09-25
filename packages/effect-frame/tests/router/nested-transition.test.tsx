import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorStopped,
  ActorTransport,
  Behavior,
  CommandId,
  Value,
  contract,
  implementQuery,
  implementTransparent,
  query as queryContract,
  spawn,
  Policies,
  Policy,
} from "effect-frame/actor";
import type {
  FollowedQuery,
  QueryCache,
  QueryFailure,
  RemoteActorRef,
  Source,
  TransportService,
} from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Location, Route, mount as mountRouter } from "effect-frame/router";
import type { AnyRoute, LocationService } from "effect-frame/router";
import { Dom, Html, Loading, Query, View, ready, render } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import type { LoadingScope } from "effect-frame/view";
import * as Frame from "../../src/frame.js";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

// ---------------------------------------------------------------------------
// Contracts and a real in-process host
// ---------------------------------------------------------------------------

const TenantInfo = queryContract("NestedTenantInfo", {
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.String,
});

const PostBody = queryContract("NestedPostBody", {
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
});

const Comments = queryContract("NestedComments", {
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
});

const SetText = Schema.TaggedStruct("SetText", { text: Schema.String });
type SetText = Schema.Schema.Type<typeof SetText>;

const Draft = contract("NestedDraft", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  snapshot: Schema.String,
  message: Schema.Union([SetText]),
});

const DraftLive = implementTransparent(
  Draft,
  Behavior.reducer<string, SetText>({ initial: "", reduce: (_state, message) => message.text }),
);

interface Held {
  readonly gate: Deferred.Deferred<void>;
  readonly started: Deferred.Deferred<void>;
}

interface FixturesService {
  readonly held: Ref.Ref<ReadonlyMap<string, Held>>;
  readonly calls: Ref.Ref<ReadonlyMap<string, number>>;
}

class Fixtures extends Context.Service<Fixtures, FixturesService>()(
  "effect-frame/tests/router/nested-transition.test/Fixtures",
) {}

/** Counts one handler call and blocks while its id is held. */
const serve = Effect.fn("NestedTest.serve")(function* (id: string) {
  const fixtures = yield* Fixtures;
  yield* Ref.update(fixtures.calls, (calls) => {
    const next = new Map(calls);
    next.set(id, Option.getOrElse(Option.fromNullishOr(calls.get(id)), () => 0) + 1);
    return next;
  });
  const held = Option.fromNullishOr((yield* Ref.get(fixtures.held)).get(id));
  if (Option.isSome(held)) {
    yield* Deferred.succeed(held.value.started, void 0);
    yield* Deferred.await(held.value.gate);
  }
  return `value:${id}`;
});

const TenantLive = implementQuery(TenantInfo, ({ tenant }) => serve(`tenant:${tenant}`));
const PostLive = implementQuery(PostBody, ({ tenant, postId }) =>
  serve(`post:${tenant}/${postId}`),
);
const CommentsLive = implementQuery(Comments, ({ tenant, postId }) =>
  serve(`comments:${tenant}/${postId}`),
);

/**
 * The wire under the real host: it records every command's address, counts
 * open change subscriptions by actor key, and can hold one snapshot read.
 */
interface WireService {
  readonly commands: Queue.Queue<string>;
  readonly subscriptions: Ref.Ref<ReadonlyMap<string, number>>;
  /** Every actor key whose change subscription opened, in order. */
  readonly opened: Queue.Queue<string>;
  readonly snapshots: Ref.Ref<ReadonlyMap<string, Held>>;
  /** Actor keys whose snapshot read fails once its hold opens. */
  readonly failing: Ref.Ref<ReadonlySet<string>>;
}

class Wire extends Context.Service<Wire, WireService>()(
  "effect-frame/tests/router/nested-transition.test/Wire",
) {}

const count = (key: string, delta: number) => (all: ReadonlyMap<string, number>) => {
  const next = new Map(all);
  next.set(key, Option.getOrElse(Option.fromNullishOr(all.get(key)), () => 0) + delta);
  return next;
};

const wired = Layer.effect(
  ActorTransport,
  Effect.gen(function* () {
    const inner = yield* ActorTransport;
    const wire = yield* Wire;
    const service: TransportService = {
      ...inner,
      snapshot: (address) =>
        Effect.gen(function* () {
          const held = Option.fromNullishOr((yield* Ref.get(wire.snapshots)).get(address.key));
          if (Option.isSome(held)) {
            yield* Deferred.succeed(held.value.started, void 0);
            yield* Deferred.await(held.value.gate);
          }
          if ((yield* Ref.get(wire.failing)).has(address.key)) {
            return yield* ActorStopped.make({});
          }
          return yield* inner.snapshot(address);
        }),
      changes: (address, after) =>
        Stream.fromEffect(
          Effect.andThen(
            Ref.update(wire.subscriptions, count(address.key, 1)),
            Queue.offer(wire.opened, address.key),
          ),
        ).pipe(
          Stream.flatMap(() => inner.changes(address, after)),
          Stream.ensuring(Ref.update(wire.subscriptions, count(address.key, -1))),
        ),
      send: (address, commandId, payload, active) =>
        Effect.andThen(
          Queue.offer(wire.commands, address.key),
          inner.send(address, commandId, payload, active),
        ),
    };
    return service;
  }),
);

const client = QueryTest.layer({
  queries: [TenantLive, PostLive, CommentsLive],
  implementations: [DraftLive],
}).pipe(Layer.provide(policies));

const makeFixtures = Effect.gen(function* () {
  return Fixtures.of({
    held: yield* Ref.make<ReadonlyMap<string, Held>>(new Map()),
    calls: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
  });
});

const makeWire = Effect.gen(function* () {
  return Wire.of({
    commands: yield* Queue.unbounded<string>(),
    subscriptions: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
    opened: yield* Queue.unbounded<string>(),
    snapshots: yield* Ref.make<ReadonlyMap<string, Held>>(new Map()),
    failing: yield* Ref.make<ReadonlySet<string>>(new Set()),
  });
});

/** The wired transport overrides the host's own; both share one host build. */
const frameLayer = (name: string) =>
  Layer.mergeAll(client, wired.pipe(Layer.provide(client))).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.effect(Fixtures, makeFixtures), Layer.effect(Wire, makeWire)),
    ),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Frame.layer({ name })),
  );

const makeHeld = Effect.gen(function* () {
  const held: Held = { gate: yield* Deferred.make<void>(), started: yield* Deferred.make<void>() };
  return held;
});

const hold = Effect.fn("NestedTest.hold")(function* (id: string) {
  const fixtures = yield* Fixtures;
  const held = yield* makeHeld;
  yield* Ref.update(fixtures.held, (all) => new Map(all).set(id, held));
  return held;
});

const draftKey = (tenant: string, postId: string): string =>
  Schema.encodeSync(Draft.key)({ tenant, postId });

const holdSnapshot = Effect.fn("NestedTest.holdSnapshot")(function* (
  tenant: string,
  postId: string,
) {
  const wire = yield* Wire;
  const held = yield* makeHeld;
  yield* Ref.update(wire.snapshots, (all) => new Map(all).set(draftKey(tenant, postId), held));
  return held;
});

const failSnapshot = Effect.fn("NestedTest.failSnapshot")(function* (
  tenant: string,
  postId: string,
) {
  const wire = yield* Wire;
  yield* Ref.update(wire.failing, (all) => new Set(all).add(draftKey(tenant, postId)));
});

/** Waits for the receipt that the actor's change subscription opened. */
const awaitOpened = Effect.fn("NestedTest.awaitOpened")(function* (tenant: string, postId: string) {
  const wire = yield* Wire;
  const key = draftKey(tenant, postId);
  while ((yield* Queue.take(wire.opened)) !== key) {
    // Earlier receipts belong to other keys.
  }
});

const callsOf = Effect.fn("NestedTest.callsOf")(function* (id: string) {
  const fixtures = yield* Fixtures;
  return Option.getOrElse(Option.fromNullishOr((yield* Ref.get(fixtures.calls)).get(id)), () => 0);
});

const subscriptionsOf = Effect.fn("NestedTest.subscriptionsOf")(function* (
  tenant: string,
  postId: string,
) {
  const wire = yield* Wire;
  return Option.getOrElse(
    Option.fromNullishOr((yield* Ref.get(wire.subscriptions)).get(draftKey(tenant, postId))),
    () => 0,
  );
});

// ---------------------------------------------------------------------------
// The two-level tenant/post tree
// ---------------------------------------------------------------------------

const TenantParams = Schema.Struct({ tenant: Schema.String });
const PostParams = Schema.Struct({ tenant: Schema.String, postId: Schema.String });

const tenantSegment = Route.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Route.query(TenantInfo, { tenant: params.tenant }) }),
});

const postSegment = Route.child(tenantSegment, "post", {
  path: "posts/:postId",
  params: PostParams,
  search: Route.search(Schema.Struct({ tab: Schema.String.pipe(Route.withDefault("read")) })),
  // The actor comes first: a sequential acquisition would hold both queries behind it.
  data: ({ params }) => ({
    draft: Route.actor(Draft, { tenant: params.tenant, postId: params.postId }),
    post: Route.query(PostBody, { tenant: params.tenant, postId: params.postId }),
    comments: Route.query(Comments, { tenant: params.tenant, postId: params.postId }),
  }),
});

const editSegment = Route.child(tenantSegment, "edit", {
  path: "posts/:postId/edit",
  params: PostParams,
  data: ({ params }) => ({
    post: Route.query(PostBody, { tenant: params.tenant, postId: params.postId }),
  }),
});

/** Two actors: a stay can hold the second read while the first is subscribed. */
const pairSegment = Route.child(tenantSegment, "pair", {
  path: "pairs/:postId",
  params: PostParams,
  data: ({ params }) => ({
    first: Route.actor(Draft, { tenant: params.tenant, postId: params.postId }),
    second: Route.actor(Draft, { tenant: params.tenant, postId: `${params.postId}-second` }),
    // A layout's Loading shows its fallback until the child registers a read.
    post: Route.query(PostBody, { tenant: params.tenant, postId: params.postId }),
  }),
});

/** Local actor revisions tell the layout's, the post view's and the edit view's actors apart. */
const LayoutRevision = 30;
const PostRevision = 40;

const spawnAtRevision = Effect.fn("NestedTest.spawnAtRevision")(function* (revision: number) {
  const local = yield* spawn(Behavior.value(0));
  for (let next = 1; next <= revision; next += 1) {
    yield* Effect.orDie(local.call(Value.Set(next)));
  }
  return local;
});

/** Receipts the views write. Plain closures, so no probe enters a view's R. */
interface Probes {
  readonly layoutSetups: Ref.Ref<number>;
  readonly postSetups: Ref.Ref<ReadonlyArray<string>>;
  readonly editSetups: Ref.Ref<ReadonlyArray<string>>;
  /** Completed when the first post view setup has built its tree. */
  readonly postBuilt: Deferred.Deferred<void>;
  /** What was still held when the post view closed. */
  readonly postClosed: Deferred.Deferred<ClosedWith>;
  /** What was still held when the layout view closed. */
  readonly layoutClosed: Deferred.Deferred<ClosedWith>;
  readonly observe: Effect.Effect<ClosedWith>;
  /** The order in which view finalizers ran. */
  readonly closeOrder: Ref.Ref<ReadonlyArray<string>>;
  /** The state each send from the control that captured its ref at setup returned. */
  readonly staleSent: Queue.Queue<{ readonly _tag: string }>;
}

interface ClosedWith {
  readonly queries: ReadonlyArray<string>;
  readonly subscriptions: ReadonlyMap<string, number>;
}

let commandCounter = 0;
const nextCommandId = () => {
  commandCounter += 1;
  return Schema.decodeSync(CommandId)(`nested-${String(commandCounter)}`);
};

const sendText = (target: RemoteActorRef<typeof Draft>, text: string) =>
  Effect.orDie(target.send(SetText.make({ text }), { commandId: nextCommandId() }));

const makeTree = (probes: Probes) => {
  const PostView = (props: Route.PropsOf<typeof postSegment>) =>
    Effect.gen(function* () {
      const first = yield* props.params.get;
      yield* Ref.update(probes.postSetups, (all) => [...all, first.postId]);
      // Registered first, so it runs after this view's other finalizers.
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          Ref.update(probes.closeOrder, (all) => [...all, "post"]),
          Effect.flatMap(probes.observe, (seen) => Deferred.succeed(probes.postClosed, seen)),
        ),
      );
      const local = yield* spawnAtRevision(PostRevision);
      // A control that captured the ref at setup keeps that address.
      const draftAtSetup = yield* props.data.draft.get;
      const title = yield* ready(props.data.post.state, "");
      const comments = yield* ready(props.data.comments.state, "");
      const tenant = yield* ready(props.data.tenant.state, "");
      yield* Deferred.succeed(probes.postBuilt, void 0);
      return (
        <article id="post">
          <h2 id="post-title">{View.bind(title)}</h2>
          <p id="post-param">{View.bind(props.params, (params) => params.postId)}</p>
          <p id="post-tab">{View.bind(props.search, (search) => search.tab)}</p>
          <p id="post-comments">{View.bind(comments)}</p>
          <p id="post-tenant">{View.bind(tenant)}</p>
          <p id="post-stale">
            {View.bind(props.data.post.state, (state) =>
              String(state._tag === "Ready" && state.stale),
            )}
          </p>
          <output id="post-actor">{View.bind(local.state, String)}</output>
          <button
            id="stale"
            onClick={View.event(() =>
              Effect.flatMap(sendText(draftAtSetup, "stale"), (handle) =>
                Effect.flatMap(handle.state.get, (state) => Queue.offer(probes.staleSent, state)),
              ),
            )}
          >
            stale
          </button>
          <button
            id="current"
            onClick={View.event(() =>
              Effect.flatMap(props.data.draft.get, (current) => sendText(current, "current")),
            )}
          >
            current
          </button>
        </article>
      );
    });

  const EditView = (props: Route.PropsOf<typeof editSegment>) =>
    Effect.gen(function* () {
      const first = yield* props.params.get;
      yield* Ref.update(probes.editSetups, (all) => [...all, first.postId]);
      const title = yield* ready(props.data.post.state, "");
      return (
        <article id="edit">
          <h2 id="edit-title">{View.bind(title)}</h2>
        </article>
      );
    });

  const PairView = (props: Route.PropsOf<typeof pairSegment>) =>
    Effect.map(ready(props.data.post.state, ""), (title) => (
      <article id="pair">
        <h2 id="pair-title">{View.bind(title)}</h2>
        <p id="pair-param">{View.bind(props.params, (params) => params.postId)}</p>
      </article>
    ));

  const tree = Route.layout(
    tenantSegment,
    [
      Route.leaf(postSegment, PostView),
      Route.leaf(editSegment, EditView),
      Route.leaf(pairSegment, PairView),
    ],
    (props) =>
      Effect.gen(function* () {
        yield* Ref.update(probes.layoutSetups, (setups) => setups + 1);
        yield* Effect.addFinalizer(() =>
          Effect.andThen(
            Ref.update(probes.closeOrder, (all) => [...all, "layout"]),
            Effect.flatMap(probes.observe, (seen) => Deferred.succeed(probes.layoutClosed, seen)),
          ),
        );
        const local = yield* spawnAtRevision(LayoutRevision);
        // The outlet is yielded inside Loading, so the child's reads register here.
        const body = yield* Loading({
          fallback: <p id="child-loading">loading child</p>,
          children: Effect.map(props.outlet, (outlet) => <div id="outlet">{outlet}</div>),
        });
        return (
          <section id="layout">
            <output id="layout-actor">{View.bind(local.state, String)}</output>
            <p id="tenant-param">{View.bind(props.params, (params) => params.tenant)}</p>
            <Query
              state={props.data.tenant.state}
              loading={<span id="tenant-name">loading</span>}
              ready={(value) => <span id="tenant-name">{View.bind(value)}</span>}
              failed={() => <span id="tenant-name">failed</span>}
            />
            {body}
          </section>
        );
      }),
  );
  return Route.client("app", tree);
};

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

const makeProbes = Effect.gen(function* () {
  const frame = yield* Frame.Service;
  const wire = yield* Wire;
  const probes: Probes = {
    layoutSetups: yield* Ref.make(0),
    postSetups: yield* Ref.make<ReadonlyArray<string>>([]),
    editSetups: yield* Ref.make<ReadonlyArray<string>>([]),
    postBuilt: yield* Deferred.make<void>(),
    postClosed: yield* Deferred.make<ClosedWith>(),
    layoutClosed: yield* Deferred.make<ClosedWith>(),
    closeOrder: yield* Ref.make<ReadonlyArray<string>>([]),
    staleSent: yield* Queue.unbounded<{ readonly _tag: string }>(),
    observe: Effect.gen(function* () {
      const snapshot = yield* frame.inspect;
      return {
        queries: queryKeys(snapshot),
        subscriptions: yield* Ref.get(wire.subscriptions),
      };
    }),
  };
  return probes;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeLocation {
  readonly service: LocationService;
  readonly history: Array<string>;
}

const makeLocation = (initial: string): Effect.Effect<FakeLocation> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const history: Array<string> = [];
    const record = (kind: string) => (url: URL) =>
      Effect.andThen(
        Ref.set(current, url),
        Effect.sync(() => {
          history.push(`${kind} ${url.pathname}${url.search}`);
        }),
      );
    return {
      service: {
        current: Ref.get(current),
        push: record("push"),
        replace: record("replace"),
        pops: Stream.never,
      },
      history,
    };
  });

const makeRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const created = document.createElement("main");
    document.body.appendChild(created);
    return created;
  }),
  (created) => Effect.sync(() => created.remove()),
);

const origin = "http://frame.test";

const mountApp = <R,>(app: AnyRoute<R>, root: HTMLElement, path: string) =>
  Effect.gen(function* () {
    const location = yield* makeLocation(`${origin}${path}`);
    const page = yield* ViewTest.make({
      host: Dom.host,
      root,
      setup: (host, mountRoot) =>
        mountRouter({ routes: [app], notFound: NotFound, host, root: mountRoot }).pipe(
          Effect.provideService(Location, location.service),
        ),
    });
    return { page, router: page.setup, location };
  });

const textAt = (root: globalThis.Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return Option.getOrElse(
    Option.fromNullishOr(root.querySelector(selector)?.textContent),
    () => "",
  );
};

const hasAt = (root: globalThis.Node, selector: string): boolean =>
  root instanceof HTMLElement && Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

const queryKeys = (snapshot: Frame.Snapshot): ReadonlyArray<string> =>
  snapshot.queries.map((record) => record.key).toSorted();

const queryRecord = (snapshot: Frame.Snapshot, contractName: string, args: string) =>
  Option.fromNullishOr(
    snapshot.queries.find(
      (record) => record.key.startsWith(`${contractName}@`) && record.key.includes(args),
    ),
  );

const onlyId = (records: ReadonlyArray<{ readonly id: Frame.Identity }>): Frame.Identity => {
  expect(records).toHaveLength(1);
  return Option.getOrThrow(Option.fromNullishOr(records[0]?.id));
};

const actorsAt = (snapshot: Frame.Snapshot, revision: number) =>
  snapshot.actors.filter((record) => record.revision === revision);

const click = (root: HTMLElement, selector: string) =>
  Effect.sync(() => {
    const target = root.querySelector(selector);
    if (target instanceof HTMLElement) {
      target.click();
    }
  });

const readyPage = (page: Effect.Success<ReturnType<typeof mountApp>>["page"], postId: string) =>
  page.waitFor({
    label: `post ${postId} content`,
    until: (actual) =>
      textAt(actual, "#post-title") === `value:post:t1/${postId}` &&
      textAt(actual, "#post-comments") === `value:comments:t1/${postId}` &&
      textAt(actual, "#post-tenant") === "value:tenant:t1" &&
      textAt(actual, "#tenant-name") === "value:tenant:t1",
  });

// ---------------------------------------------------------------------------
// Type fixtures. Unannotated expressions only.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RouteServices<T> = T extends AnyRoute<infer R> ? R : never;
type PostData = Route.PropsOf<typeof postSegment>["data"];

type TypedApp = ReturnType<typeof makeTree>;

/** The layout's Loading consumes the child's LoadingScope; only data services remain. */
const routeServices: Equals<RouteServices<TypedApp>, QueryCache | ActorTransport> = true;
const inheritedTenant: Equals<PostData["tenant"], FollowedQuery<string, QueryFailure>> = true;
const ownPost: Equals<PostData["post"], FollowedQuery<string, QueryFailure>> = true;
const actorSource: Equals<PostData["draft"], Source<RemoteActorRef<typeof Draft>>> = true;
const postParams: Equals<
  Effect.Success<Route.PropsOf<typeof postSegment>["params"]["get"]>,
  { readonly tenant: string; readonly postId: string }
> = true;

/** A layout that places the outlet outside Loading leaks the child's LoadingScope. */
const leaky = Route.client(
  "leaky",
  Route.layout(
    tenantSegment,
    [
      Route.leaf(editSegment, (props) =>
        Effect.map(ready(props.data.post.state, ""), (title) => <h2>{View.bind(title)}</h2>),
      ),
    ],
    (props) => Effect.map(props.outlet, (outlet) => <div>{outlet}</div>),
  ),
);
const leakyServices: Equals<
  RouteServices<typeof leaky>,
  QueryCache | ActorTransport | LoadingScope
> = true;

// Negative fixtures below are TypeScript errors by design. The Effect language
// service reports the same mismatch separately, so it is paused for them only.
// @effect-diagnostics missingEffectError:off
// @ts-expect-error The leaked LoadingScope is part of the route's requirements.
const leakyWithoutScope: Equals<RouteServices<typeof leaky>, QueryCache | ActorTransport> = true;

const collision = Route.child(tenantSegment, "collision", {
  path: "c",
  params: TenantParams,
  // @ts-expect-error A child may not redeclare a name its parent declared.
  data: ({ params }) => ({ tenant: Route.query(TenantInfo, { tenant: params.tenant }) }),
});

// @ts-expect-error A binding that no declaration names does not exist.
const missingBinding: PostData["missing"] = Option.none();

const notARef = (
  value: PostData["draft"],
  // @ts-expect-error An actor binding is a Source of a ref, not a ref.
): RemoteActorRef<typeof Draft> => value;
// @effect-diagnostics missingEffectError:error

const typeFixtures = [
  routeServices,
  inheritedTenant,
  ownPost,
  actorSource,
  postParams,
  leakyServices,
  leakyWithoutScope,
  collision,
  missingBinding,
  notARef,
];

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

describe("private nested transition", () => {
  it.effect("keeps exact route data and requirement types", () =>
    Effect.sync(() => {
      expect(typeFixtures.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    }),
  );

  it.effect("9. rejects a child path param that shadows an ancestor's", () =>
    Effect.gen(function* () {
      const rejection = (declare: () => void) =>
        Effect.flip(
          Effect.try({ try: declare, catch: Schema.decodeUnknownSync(Route.BranchRejected) }),
        );
      // A direct child may not reuse its parent's param name.
      expect(
        yield* rejection(() =>
          Route.child(tenantSegment, "shadow", { path: "items/:tenant", params: TenantParams }),
        ),
      ).toMatchObject({
        _tag: "BranchRejected",
        segment: "shadow",
        reason: "path param tenant is already declared by tenant",
      });
      // A grandchild is checked against every ancestor, tails included.
      expect(
        yield* rejection(() =>
          Route.child(postSegment, "deep", { path: "files/:tenant*", params: PostParams }),
        ),
      ).toMatchObject({
        _tag: "BranchRejected",
        segment: "deep",
        reason: "path param tenant is already declared by tenant",
      });
      // A new name is accepted.
      const accepted = Route.child(postSegment, "file", {
        path: "files/:fileId",
        params: Schema.Struct({ ...PostParams.fields, fileId: Schema.String }),
      });
      expect(accepted.name).toBe("file");
    }),
  );

  it.scoped.layer(frameLayer("nested-first-entry"))(
    "1. starts every declaration in parallel, then starts the unseeded child under the layout Loading",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const tenantHeld = yield* hold("tenant:t1");
        const postHeld = yield* hold("post:t1/1");
        const commentsHeld = yield* hold("comments:t1/1");
        const snapshotHeld = yield* holdSnapshot("t1", "1");
        const mounting = yield* Effect.forkChild(
          mountApp(makeTree(probes), root, "/app/t1/posts/1"),
        );

        // Every query started while the actor's first snapshot is still held.
        yield* Deferred.await(tenantHeld.started);
        yield* Deferred.await(postHeld.started);
        yield* Deferred.await(commentsHeld.started);
        yield* Deferred.await(snapshotHeld.started);
        const acquiring = yield* Frame.inspect;
        expect(queryKeys(acquiring)).toHaveLength(3);
        expect(acquiring.queries.every((record) => record.state === "Loading")).toBe(true);
        // Route preparation comes first: no view has run.
        expect(yield* Ref.get(probes.layoutSetups)).toBe(0);
        expect(yield* Ref.get(probes.postSetups)).toEqual([]);
        expect(acquiring.actors).toHaveLength(0);

        yield* Deferred.succeed(snapshotHeld.gate, void 0);
        const { page } = yield* Fiber.join(mounting);
        yield* page.waitFor({
          label: "layout fallback while the child's held queries run",
          until: (actual) =>
            textAt(actual, "#child-loading") === "loading child" &&
            textAt(actual, "#layout-actor") === String(LayoutRevision) &&
            !hasAt(actual, "#post"),
        });
        // The unseeded child started under the fallback.
        yield* Deferred.await(probes.postBuilt);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
        expect(hasAt(root, "#child-loading")).toBe(true);
        const started = yield* Frame.inspect;
        expect(actorsAt(started, PostRevision)).toHaveLength(1);
        expect(started.mounts).toHaveLength(1);
        expect(started.routes.map((record) => record.routeName)).toEqual(["app"]);
        expect(yield* subscriptionsOf("t1", "1")).toBe(1);

        yield* Deferred.succeed(tenantHeld.gate, void 0);
        yield* Deferred.succeed(postHeld.gate, void 0);
        yield* page.waitFor({
          label: "child still pending on its comments",
          until: (actual) =>
            textAt(actual, "#tenant-name") === "value:tenant:t1" && hasAt(actual, "#child-loading"),
        });
        yield* Deferred.succeed(commentsHeld.gate, void 0);
        yield* readyPage(page, "1");
        expect(hasAt(root, "#child-loading")).toBe(false);
        expect(yield* Ref.get(probes.layoutSetups)).toBe(1);
        expect(yield* callsOf("tenant:t1")).toBe(1);
        expect(yield* callsOf("post:t1/1")).toBe(1);
        expect(yield* callsOf("comments:t1/1")).toBe(1);
      }),
  );

  it.scoped.layer(frameLayer("nested-replacement"))(
    "2. replaces the child under a retained layout and overlaps a shared key",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, router, location } = yield* mountApp(
          makeTree(probes),
          root,
          "/app/t1/posts/1",
        );
        yield* readyPage(page, "1");
        const layoutElement = root.querySelector("#layout");
        const outletElement = root.querySelector("#outlet");
        const before = yield* Frame.inspect;
        const layoutActorId = onlyId(actorsAt(before, LayoutRevision));
        const postQueryId = Option.map(
          queryRecord(before, "NestedPostBody", "t1"),
          (record) => record.id,
        );
        const tenantQueryId = Option.map(
          queryRecord(before, "NestedTenantInfo", "t1"),
          (record) => record.id,
        );

        yield* page.act(router.navigate("/app/t1/posts/1/edit"), {
          label: "edit child replaces the post child",
          until: (actual) =>
            textAt(actual, "#edit-title") === "value:post:t1/1" && !hasAt(actual, "#post"),
        });

        // The exited view closed while its declarations were still held.
        const closedWith = yield* Deferred.await(probes.postClosed);
        expect(closedWith.subscriptions.get(draftKey("t1", "1"))).toBe(1);
        expect(closedWith.queries.some((key) => key.startsWith("NestedComments@"))).toBe(true);

        const after = yield* Frame.inspect;
        expect(root.querySelector("#layout")).toBe(layoutElement);
        expect(root.querySelector("#outlet")).toBe(outletElement);
        expect(yield* Ref.get(probes.layoutSetups)).toBe(1);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
        expect(yield* Ref.get(probes.editSetups)).toEqual(["1"]);
        expect(onlyId(actorsAt(after, LayoutRevision))).toBe(layoutActorId);
        expect(actorsAt(after, PostRevision)).toHaveLength(0);
        // Entering-before-exited: the shared post key kept its entry and was read once.
        expect(yield* callsOf("post:t1/1")).toBe(1);
        expect(
          Option.map(queryRecord(after, "NestedPostBody", "t1"), (record) => record.id),
        ).toEqual(postQueryId);
        expect(yield* callsOf("tenant:t1")).toBe(1);
        expect(
          Option.map(queryRecord(after, "NestedTenantInfo", "t1"), (record) => record.id),
        ).toEqual(tenantQueryId);
        // Keys only the exited child declared are released after its view closed.
        expect(Option.isNone(queryRecord(after, "NestedComments", "t1"))).toBe(true);
        expect(yield* subscriptionsOf("t1", "1")).toBe(0);
        expect(queryKeys(after)).toHaveLength(2);
        expect(location.history).toEqual(["push /app/t1/posts/1/edit"]);
      }),
  );

  it.scoped.layer(frameLayer("nested-param-move"))(
    "3. moves query and actor bindings on a post-ID change while the view stays",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const wire = yield* Wire;
        const { page, router } = yield* mountApp(makeTree(probes), root, "/app/t1/posts/1");
        yield* readyPage(page, "1");
        const postElement = root.querySelector("#post");
        const before = yield* Frame.inspect;
        const postActorId = onlyId(actorsAt(before, PostRevision));
        const layoutActorId = onlyId(actorsAt(before, LayoutRevision));

        const snapshot2 = yield* holdSnapshot("t1", "2");
        const post2 = yield* hold("post:t1/2");
        const moving = yield* Effect.forkChild(router.navigate("/app/t1/posts/2"));
        yield* Deferred.await(snapshot2.started);
        yield* Deferred.await(post2.started);

        // Nothing is published while the new actor is still being acquired:
        // params and the current actor handle still agree on post 1.
        expect(textAt(root, "#post-param")).toBe("1");
        yield* click(root, "#current");
        expect(yield* Queue.take(wire.commands)).toBe(draftKey("t1", "1"));

        yield* Deferred.succeed(snapshot2.gate, void 0);
        yield* Fiber.join(moving);
        // The query binding moved and carries the last value, marked stale.
        yield* page.waitFor({
          label: "params published; the post binding carries a stale value",
          until: (actual) =>
            textAt(actual, "#post-param") === "2" &&
            textAt(actual, "#post-title") === "value:post:t1/1" &&
            textAt(actual, "#post-stale") === "true" &&
            !hasAt(actual, "#child-loading"),
        });
        expect(yield* subscriptionsOf("t1", "1")).toBe(0);
        expect(yield* subscriptionsOf("t1", "2")).toBe(1);

        yield* Deferred.succeed(post2.gate, void 0);
        yield* readyPage(page, "2");
        expect(textAt(root, "#post-stale")).toBe("false");

        const after = yield* Frame.inspect;
        expect(root.querySelector("#post")).toBe(postElement);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
        expect(yield* Ref.get(probes.layoutSetups)).toBe(1);
        expect(onlyId(actorsAt(after, PostRevision))).toBe(postActorId);
        expect(onlyId(actorsAt(after, LayoutRevision))).toBe(layoutActorId);
        // No extra refetch for the unchanged ancestor key.
        expect(yield* callsOf("tenant:t1")).toBe(1);
        expect(yield* callsOf("post:t1/1")).toBe(1);
        expect(yield* callsOf("post:t1/2")).toBe(1);
        expect(yield* callsOf("comments:t1/2")).toBe(1);
        expect(Option.isNone(queryRecord(after, "NestedPostBody", '"postId":"1"'))).toBe(true);
        expect(queryKeys(after)).toHaveLength(3);

        // The retained control still holds its old ref, which the move
        // released: its command does no work and never reaches the wire,
        // rather than being reinterpreted for the new address. Its ID is
        // supplied, so the closed owner reports Uncertain before any pass
        // instead of claiming a refusal. The current handle commands the new
        // address, and it is the next command on the wire.
        yield* click(root, "#stale");
        expect(yield* Queue.take(probes.staleSent)).toMatchObject({
          _tag: "Uncertain",
          attempt: 0,
        });
        yield* click(root, "#current");
        expect(yield* Queue.take(wire.commands)).toBe(draftKey("t1", "2"));

        // A search-only change moves no key, yet publishes the new search
        // and keeps every declaration and every entry.
        expect(textAt(root, "#post-tab")).toBe("read");
        yield* page.act(router.navigate("/app/t1/posts/2?tab=comments"), {
          label: "search refinement publishes the new tab",
          until: (actual) =>
            textAt(actual, "#post-tab") === "comments" && textAt(actual, "#post-param") === "2",
        });
        expect(yield* callsOf("post:t1/2")).toBe(1);
        expect(yield* subscriptionsOf("t1", "2")).toBe(1);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
      }),
  );

  it.scoped.layer(frameLayer("nested-close"))(
    "4. closes one child, then the root, with records removed in order",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, router } = yield* mountApp(makeTree(probes), root, "/app/t1/posts/1");
        yield* readyPage(page, "1");
        const layoutElement = root.querySelector("#layout");
        const before = yield* Frame.inspect;
        const layoutActorId = onlyId(actorsAt(before, LayoutRevision));
        const tenantQueryId = Option.map(
          queryRecord(before, "NestedTenantInfo", "t1"),
          (record) => record.id,
        );

        yield* page.act(router.navigate("/app/t1"), {
          label: "the layout alone",
          until: (actual) =>
            !hasAt(actual, "#post") && hasAt(actual, "#layout") && !hasAt(actual, "#child-loading"),
        });
        const childClosed = yield* Frame.inspect;
        expect(root.querySelector("#layout")).toBe(layoutElement);
        expect(actorsAt(childClosed, PostRevision)).toHaveLength(0);
        expect(onlyId(actorsAt(childClosed, LayoutRevision))).toBe(layoutActorId);
        expect(queryKeys(childClosed)).toHaveLength(1);
        expect(
          Option.map(queryRecord(childClosed, "NestedTenantInfo", "t1"), (record) => record.id),
        ).toEqual(tenantQueryId);
        expect(yield* subscriptionsOf("t1", "1")).toBe(0);
        expect(childClosed.mounts).toHaveLength(1);
        expect(childClosed.routes).toHaveLength(1);
        // An empty outlet leaves no registration, so the layout's Loading shows its content.
        expect(hasAt(root, "#child-loading")).toBe(false);

        yield* page.close;
        // The layout view closed before the root released its tenant interest.
        const layoutClosedWith = yield* Deferred.await(probes.layoutClosed);
        expect(layoutClosedWith.queries.some((key) => key.startsWith("NestedTenantInfo@"))).toBe(
          true,
        );
        const closed = yield* Frame.inspect;
        // Only the host's durable Draft instance remains: it is server state.
        expect(closed.actors.filter((record) => record.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
        expect(yield* callsOf("tenant:t1")).toBe(1);
      }),
  );

  it.scoped.layer(frameLayer("nested-root-close"))(
    "6. closes the root with a child mounted: views close child first, before any interest",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page } = yield* mountApp(makeTree(probes), root, "/app/t1/posts/1");
        yield* readyPage(page, "1");

        yield* page.close;
        // The child view closes before the layout view that holds its outlet.
        expect(yield* Ref.get(probes.closeOrder)).toEqual(["post", "layout"]);
        // Both views closed while every declared interest was still held.
        const postClosedWith = yield* Deferred.await(probes.postClosed);
        expect(postClosedWith.subscriptions.get(draftKey("t1", "1"))).toBe(1);
        expect(postClosedWith.queries).toHaveLength(3);
        const layoutClosedWith = yield* Deferred.await(probes.layoutClosed);
        expect(layoutClosedWith.queries.some((key) => key.startsWith("NestedTenantInfo@"))).toBe(
          true,
        );
        const closed = yield* Frame.inspect;
        expect(closed.actors.filter((record) => record.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
        expect(yield* subscriptionsOf("t1", "1")).toBe(0);
      }),
  );

  it.scoped.layer(frameLayer("nested-close-held"))(
    "7. closes the root during a held stay acquisition: nothing is published or leaked",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, router } = yield* mountApp(makeTree(probes), root, "/app/t1/pairs/1");
        yield* page.waitFor({
          label: "pair 1",
          until: (actual) =>
            textAt(actual, "#pair-param") === "1" &&
            textAt(actual, "#pair-title") === "value:post:t1/1" &&
            textAt(actual, "#tenant-name") === "value:tenant:t1",
        });
        expect(yield* subscriptionsOf("t1", "1")).toBe(1);
        expect(yield* subscriptionsOf("t1", "1-second")).toBe(1);

        // The second read is held; the first completes and opens its changes.
        const second2 = yield* holdSnapshot("t1", "2-second");
        const moving = yield* Effect.forkChild(router.navigate("/app/t1/pairs/2"));
        yield* Deferred.await(second2.started);
        yield* awaitOpened("t1", "2");

        // Acquired but unpublished: after a flush the view still shows pair 1.
        yield* page.waitFor({
          label: "pair 1 params while the stay is held",
          until: (actual) => textAt(actual, "#pair-param") === "1",
        });
        expect(yield* subscriptionsOf("t1", "2")).toBe(1);
        expect(yield* subscriptionsOf("t1", "1")).toBe(1);

        yield* page.close;
        yield* Deferred.succeed(second2.gate, void 0);
        yield* Fiber.await(moving);

        expect(yield* Ref.get(probes.closeOrder)).toEqual(["layout"]);
        // The acquired but unpublished interest is released with the root.
        expect(yield* subscriptionsOf("t1", "2")).toBe(0);
        expect(yield* subscriptionsOf("t1", "2-second")).toBe(0);
        expect(yield* subscriptionsOf("t1", "1")).toBe(0);
        expect(yield* subscriptionsOf("t1", "1-second")).toBe(0);
        const closed = yield* Frame.inspect;
        expect(closed.actors.filter((record) => record.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
      }),
  );

  it.scoped.layer(frameLayer("nested-stay-failure"))(
    "8. a failed read during a stay releases every sibling it acquired and publishes nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const wire = yield* Wire;
        const { page, router } = yield* mountApp(makeTree(probes), root, "/app/t1/posts/1");
        yield* readyPage(page, "1");

        const snapshot2 = yield* holdSnapshot("t1", "2");
        yield* failSnapshot("t1", "2");
        const post2 = yield* hold("post:t1/2");
        const comments2 = yield* hold("comments:t1/2");
        const moving = yield* Effect.forkChild(router.navigate("/app/t1/posts/2"));
        yield* Deferred.await(snapshot2.started);
        yield* Deferred.await(post2.started);
        yield* Deferred.await(comments2.started);

        // The sibling query interests are acquired before the actor read fails.
        const acquiring = yield* Frame.inspect;
        expect(Option.isSome(queryRecord(acquiring, "NestedPostBody", '"postId":"2"'))).toBe(true);
        expect(Option.isSome(queryRecord(acquiring, "NestedComments", '"postId":"2"'))).toBe(true);

        yield* Deferred.succeed(snapshot2.gate, void 0);
        // The navigation reports the read failure.
        expect(Exit.isFailure(yield* Fiber.await(moving))).toBe(true);

        // Every acquired part is released.
        const after = yield* Frame.inspect;
        expect(Option.isNone(queryRecord(after, "NestedPostBody", '"postId":"2"'))).toBe(true);
        expect(Option.isNone(queryRecord(after, "NestedComments", '"postId":"2"'))).toBe(true);
        expect(queryKeys(after)).toHaveLength(3);
        expect(yield* subscriptionsOf("t1", "2")).toBe(0);
        expect(yield* subscriptionsOf("t1", "1")).toBe(1);

        // Nothing is published: after a flush the view still shows post 1,
        // fresh, and its current actor handle still commands post 1.
        yield* page.waitFor({
          label: "post 1 params and data after the failed stay",
          until: (actual) =>
            textAt(actual, "#post-param") === "1" &&
            textAt(actual, "#post-title") === "value:post:t1/1" &&
            textAt(actual, "#post-stale") === "false",
        });
        yield* click(root, "#current");
        expect(yield* Queue.take(wire.commands)).toBe(draftKey("t1", "1"));
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
        expect(yield* Ref.get(probes.layoutSetups)).toBe(1);
      }),
  );

  it.scoped.layer(frameLayer("nested-html"))(
    "5. serializes the retained layout and its Loading fallback in the first HTML frame",
    () =>
      Effect.gen(function* () {
        const probes = yield* makeProbes;
        const postHeld = yield* hold("post:t1/1");
        const location: LocationService = {
          current: Effect.succeed(new URL(`${origin}/app/t1/posts/1`)),
          push: () => Effect.void,
          replace: () => Effect.void,
          pops: Stream.never,
        };
        const scope = yield* Scope.make();
        const htmlRoot = Html.element("#root");
        yield* mountRouter({
          routes: [makeTree(probes)],
          notFound: NotFound,
          host: Html.host,
          root: htmlRoot,
        }).pipe(Effect.provideService(Location, location), Scope.provide(scope));
        yield* render;
        const html = Html.serializeChildren(htmlRoot.children);
        yield* Deferred.await(postHeld.started);
        yield* Scope.close(scope, Exit.void);

        expect(html).toContain('<section id="layout">');
        expect(html).toContain('<p id="child-loading">loading child</p>');
        expect(html).not.toContain('id="post"');
        const closed = yield* Frame.inspect;
        // Only the host's durable Draft instance remains: it is server state.
        expect(closed.actors.filter((record) => record.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
        expect(yield* subscriptionsOf("t1", "1")).toBe(0);
      }),
  );
});
