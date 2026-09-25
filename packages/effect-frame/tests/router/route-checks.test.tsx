import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Actor,
  ActorStopped,
  ActorTransport,
  Behavior,
  CommandId,
  Value,
  contract,
  implementQuery,
  implementTransparent,
  query as queryContract,
  Policies,
  Policy,
} from "effect-frame/actor";
import type { QueryCache, RemoteActorRef, Source, TransportService } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Location, Route, mount as mountRouter, NavigationBehavior } from "effect-frame/router";
import type { AnyRoute, LocationService } from "effect-frame/router";
import { Dom, Await, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import * as Frame from "../../src/frame.js";
import * as Check from "../../src/router/check.js";
import * as Receipt from "../../src/router/receipt.js";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

// ---------------------------------------------------------------------------
// Contracts and a real in-process host
// ---------------------------------------------------------------------------

const TenantInfo = queryContract("CheckedTenantInfo", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.String,
  depends: [],
});

const PostBody = queryContract("CheckedPostBody", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
  depends: [],
});

const Comments = queryContract("CheckedComments", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
  depends: [],
});

const SetText = Schema.TaggedStruct("SetText", { text: Schema.String });
type SetText = Schema.Schema.Type<typeof SetText>;

const Draft = contract("CheckedDraft", {
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

class QueryBroke extends Schema.TaggedError<QueryBroke>()("QueryBroke", {
  id: Schema.String,
}) {}

interface FixturesService {
  readonly held: Ref.Ref<ReadonlyMap<string, Held>>;
  readonly calls: Ref.Ref<ReadonlyMap<string, number>>;
  /** Handler ids that fail once their hold opens. */
  readonly failing: Ref.Ref<ReadonlySet<string>>;
}

class Fixtures extends Context.Service<Fixtures, FixturesService>()(
  "effect-frame/tests/router/route-checks.test/Fixtures",
) {}

const serve = Effect.fn("ChecksTest.serve")(function* (id: string) {
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
  if ((yield* Ref.get(fixtures.failing)).has(id)) {
    return yield* QueryBroke.make({ id });
  }
  return `value:${id}`;
});

const TenantLive = implementQuery(TenantInfo, { run: ({ tenant }) => serve(`tenant:${tenant}`) });
const PostLive = implementQuery(PostBody, {
  run: ({ tenant, postId }) => serve(`post:${tenant}/${postId}`),
});
const CommentsLive = implementQuery(Comments, {
  run: ({ tenant, postId }) => serve(`comments:${tenant}/${postId}`),
});

interface WireService {
  readonly commands: Queue.Queue<string>;
  readonly subscriptions: Ref.Ref<ReadonlyMap<string, number>>;
  /** Actor keys whose snapshot read fails. */
  readonly failing: Ref.Ref<ReadonlySet<string>>;
}

class Wire extends Context.Service<Wire, WireService>()(
  "effect-frame/tests/router/route-checks.test/Wire",
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
          if ((yield* Ref.get(wire.failing)).has(address.key)) {
            return yield* ActorStopped.make({});
          }
          return yield* inner.snapshot(address);
        }),
      changes: (address, after) =>
        Stream.fromEffect(Ref.update(wire.subscriptions, count(address.key, 1))).pipe(
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

// ---------------------------------------------------------------------------
// The navigation access service a check needs
// ---------------------------------------------------------------------------

/** One question a check was asked, as the check saw it. */
interface Asked {
  readonly segment: string;
  readonly params: unknown;
  readonly search: unknown;
  readonly url: string;
  readonly kind: Route.NavigationKind;
}

interface AccessService {
  /** Every question, in the order the checks were asked. */
  readonly asked: Queue.Queue<Asked>;
  readonly log: Ref.Ref<ReadonlyArray<Asked>>;
  /** Tenants whose members are signed out: the tenant check redirects. */
  readonly denied: Ref.Ref<ReadonlySet<string>>;
  /** Tenants whose decision is held until the gate opens. */
  readonly held: Ref.Ref<ReadonlyMap<string, Held>>;
}

class Access extends Context.Service<Access, AccessService>()(
  "effect-frame/tests/router/route-checks.test/Access",
) {}

const record = Effect.fn("ChecksTest.record")(function* (asked: Asked) {
  const access = yield* Access;
  yield* Ref.update(access.log, (all) => [...all, asked]);
  yield* Queue.offer(access.asked, asked);
});

const makeAccess = Effect.gen(function* () {
  return Access.of({
    asked: yield* Queue.unbounded<Asked>(),
    log: yield* Ref.make<ReadonlyArray<Asked>>([]),
    denied: yield* Ref.make<ReadonlySet<string>>(new Set()),
    held: yield* Ref.make<ReadonlyMap<string, Held>>(new Map()),
  });
});

const makeFixtures = Effect.gen(function* () {
  return Fixtures.of({
    held: yield* Ref.make<ReadonlyMap<string, Held>>(new Map()),
    calls: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
    failing: yield* Ref.make<ReadonlySet<string>>(new Set()),
  });
});

const makeWire = Effect.gen(function* () {
  return Wire.of({
    commands: yield* Queue.unbounded<string>(),
    subscriptions: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
    failing: yield* Ref.make<ReadonlySet<string>>(new Set()),
  });
});

const client = QueryTest.layer({
  queries: [TenantLive, PostLive, CommentsLive],
  implementations: [DraftLive],
}).pipe(Layer.provide(policies));

const frameLayer = (name: string) =>
  Layer.mergeAll(client, wired.pipe(Layer.provide(client))).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(Fixtures, makeFixtures),
        Layer.effect(Wire, makeWire),
        Layer.effect(Access, makeAccess),
      ),
    ),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Frame.layer({ name })),
  );

const makeHeld = Effect.gen(function* () {
  const held: Held = { gate: yield* Deferred.make<void>(), started: yield* Deferred.make<void>() };
  return held;
});

const holdQuery = Effect.fn("ChecksTest.holdQuery")(function* (id: string) {
  const fixtures = yield* Fixtures;
  const held = yield* makeHeld;
  yield* Ref.update(fixtures.held, (all) => new Map(all).set(id, held));
  return held;
});

const failQuery = Effect.fn("ChecksTest.failQuery")(function* (id: string) {
  const fixtures = yield* Fixtures;
  yield* Ref.update(fixtures.failing, (all) => new Set(all).add(id));
});

const holdDecision = Effect.fn("ChecksTest.holdDecision")(function* (tenant: string) {
  const access = yield* Access;
  const held = yield* makeHeld;
  yield* Ref.update(access.held, (all) => new Map(all).set(tenant, held));
  return held;
});

const deny = Effect.fn("ChecksTest.deny")(function* (tenant: string) {
  const access = yield* Access;
  yield* Ref.update(access.denied, (all) => new Set(all).add(tenant));
});

const draftKey = (tenant: string, postId: string): string =>
  Schema.encodeSync(Draft.key)({ tenant, postId });

const failSnapshot = Effect.fn("ChecksTest.failSnapshot")(function* (
  tenant: string,
  postId: string,
) {
  const wire = yield* Wire;
  yield* Ref.update(wire.failing, (all) => new Set(all).add(draftKey(tenant, postId)));
});

const callsOf = Effect.fn("ChecksTest.callsOf")(function* (id: string) {
  const fixtures = yield* Fixtures;
  return Option.getOrElse(Option.fromNullishOr((yield* Ref.get(fixtures.calls)).get(id)), () => 0);
});

const subscriptionsOf = Effect.fn("ChecksTest.subscriptionsOf")(function* (
  tenant: string,
  postId: string,
) {
  const wire = yield* Wire;
  return Option.getOrElse(
    Option.fromNullishOr((yield* Ref.get(wire.subscriptions)).get(draftKey(tenant, postId))),
    () => 0,
  );
});

const askedLog = Effect.fn("ChecksTest.askedLog")(function* () {
  const access = yield* Access;
  return yield* Ref.get(access.log);
});

/** A compact form of the questions: `segment:path:kind`. */
const questions = (log: ReadonlyArray<Asked>): ReadonlyArray<string> =>
  log.map((one) => `${one.segment}:${new URL(one.url).pathname}:${one.kind}`);

// ---------------------------------------------------------------------------
// The tenant/post tree with checks and typed failures
// ---------------------------------------------------------------------------

const LoginRouteSegment = Route.segment("login", {
  path: "/login",
  params: Schema.Struct({}),
  search: Route.search(Schema.Struct({ next: Schema.String.pipe(Route.withDefault("/")) })),
});
const LoginRoute = Route.client(
  "login",
  Route.leaf(LoginRouteSegment, (props) =>
    Effect.succeed(<p id="login">{View.bind(props.search, (search) => search.next)}</p>),
  ),
);

const TenantParams = Schema.Struct({ tenant: Schema.String });
const PostParams = Schema.Struct({ tenant: Schema.String, postId: Schema.String });

/**
 * The tenant check: an unannotated function whose services are `Access`.
 * A denied tenant goes to sign-in with a typed target.
 */
const checkTenant = (next: Route.BeforeInput<{ readonly tenant: string }, {}>) =>
  Effect.gen(function* () {
    const access = yield* Access;
    yield* record({ segment: "tenant", ...next, url: next.url.href });
    const held = Option.fromNullishOr((yield* Ref.get(access.held)).get(next.params.tenant));
    if (Option.isSome(held)) {
      yield* Deferred.succeed(held.value.started, void 0);
      yield* Deferred.await(held.value.gate);
    }
    if ((yield* Ref.get(access.denied)).has(next.params.tenant)) {
      return Route.redirect(LoginRouteSegment, {}, { next: next.url.pathname });
    }
    return Route.Continue;
  });

const tenantSegment = Route.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Route.query(TenantInfo, { tenant: params.tenant }) }),
  before: checkTenant,
});

const postSegment = Route.child(tenantSegment, "post", {
  path: "posts/:postId",
  params: PostParams,
  search: Route.search(Schema.Struct({ tab: Schema.String.pipe(Route.withDefault("read")) })),
  data: ({ params }) => ({
    draft: Route.actor(Draft, { tenant: params.tenant, postId: params.postId }),
    post: Route.query(PostBody, { tenant: params.tenant, postId: params.postId }),
    comments: Route.query(Comments, { tenant: params.tenant, postId: params.postId }),
  }),
  before: (next) => checkPost(next),
});

/**
 * Redirect loops for the cycle proofs; every other post continues. It names
 * the post segment as its own target, so its type is written out.
 */
function checkPost(
  next: Route.BeforeInput<
    { readonly tenant: string; readonly postId: string },
    { readonly tab: string }
  >,
): Effect.Effect<Route.Verdict, never, Access> {
  return Effect.gen(function* () {
    yield* record({ segment: "post", ...next, url: next.url.href });
    const { tenant, postId } = next.params;
    const to = (id: string) => Route.redirect(postSegment, { tenant, postId: id }, { tab: "read" });
    if (postId === "loop-a") {
      return to("loop-b");
    }
    if (postId === "loop-b") {
      return to("loop-a");
    }
    if (postId.startsWith("step-")) {
      return to(`step-${String(Number(postId.slice(5)) + 1)}`);
    }
    return Route.Continue;
  });
}

class PostFailed extends Schema.TaggedError<PostFailed>()("PostFailed", {
  postId: Schema.String,
}) {}

class LayoutFailed extends Schema.TaggedError<LayoutFailed>()("LayoutFailed", {
  tenant: Schema.String,
}) {}

const LayoutRevision = 30;
const PostRevision = 40;

const spawnAtRevision = Effect.fn("ChecksTest.spawnAtRevision")(function* (revision: number) {
  const local = yield* Actor.local(Behavior.value(0));
  for (let next = 1; next <= revision; next += 1) {
    yield* Effect.orDie(local.call(Value.Set(next)));
  }
  return local;
});

interface Probes {
  readonly layoutSetups: Ref.Ref<ReadonlyArray<string>>;
  readonly postSetups: Ref.Ref<ReadonlyArray<string>>;
  readonly postBuilt: Deferred.Deferred<void>;
  readonly postClosed: Deferred.Deferred<void>;
  /** Setup closes and errored builds, in order. Plain, so errored may write it. */
  readonly order: Array<string>;
}

let commandCounter = 0;
const nextCommandId = () => {
  commandCounter += 1;
  return Schema.decodeSync(CommandId)(`checks-${String(commandCounter)}`);
};

const sendText = (target: RemoteActorRef<typeof Draft>, text: string) =>
  Effect.orDie(target.send(SetText.make({ text }), { commandId: nextCommandId() }));

const describeFailure = <E extends { readonly _tag: string }>(
  failure: Route.RouteFailure<E>,
): string => {
  if (failure._tag === "Setup") {
    return `Setup:${failure.error._tag}`;
  }
  return `Declaration:${failure.error._tag}`;
};

const makeApp = (probes: Probes) => {
  const PostView = (props: Route.PropsOf<typeof postSegment>) =>
    Effect.gen(function* () {
      const first = yield* props.params.get;
      yield* Ref.update(probes.postSetups, (all) => [...all, first.postId]);
      yield* Effect.addFinalizer(() => Deferred.succeed(probes.postClosed, void 0));
      const local = yield* spawnAtRevision(PostRevision);
      if (first.postId === "bad") {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            probes.order.push("setup-closed");
          }),
        );
        return yield* PostFailed.make({ postId: first.postId });
      }
      const title = yield* View.ready(props.data.post.state, "");
      yield* Deferred.succeed(probes.postBuilt, void 0);
      return (
        <article id="post">
          <h2 id="post-title">{View.bind(title)}</h2>
          <p id="post-param">{View.bind(props.params, (params) => params.postId)}</p>
          <output id="post-actor">{View.bind(local.state, String)}</output>
          <Await
            state={props.data.comments.state}
            loading={<span id="comments">loading</span>}
            ready={(value) => <span id="comments">{View.bind(value)}</span>}
            failed={() => <span id="comments">failed</span>}
          />
          <button id="boom" onClick={View.event(() => Effect.die("boom"))}>
            boom
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

  const tree = Route.layout(
    tenantSegment,
    [
      Route.leaf(postSegment, PostView, {
        errored: (failure) => {
          probes.order.push("errored-built");
          return <p id="post-errored">{View.bind(failure, describeFailure)}</p>;
        },
      }),
    ],
    (props) =>
      Effect.gen(function* () {
        const params = yield* props.params.get;
        yield* Ref.update(probes.layoutSetups, (all) => [...all, params.tenant]);
        if (params.tenant === "broken") {
          return yield* LayoutFailed.make({ tenant: params.tenant });
        }
        const local = yield* spawnAtRevision(LayoutRevision);
        const body = yield* View.loading({
          fallback: <p id="child-loading">loading child</p>,
          content: Effect.map(props.outlet, (outlet) => <div id="outlet">{outlet}</div>),
        });
        return (
          <section id="layout">
            <output id="layout-actor">{View.bind(local.state, String)}</output>
            <p id="tenant-param">{View.bind(props.params, (value) => value.tenant)}</p>
            <Await
              state={props.data.tenant.state}
              loading={<span id="tenant-name">loading</span>}
              ready={(value) => <span id="tenant-name">{View.bind(value)}</span>}
              failed={() => <span id="tenant-name">failed</span>}
            />
            {body}
          </section>
        );
      }),
    {
      errored: (failure) => <p id="layout-errored">{View.bind(failure, describeFailure)}</p>,
    },
  );
  return Route.client("app", tree);
};

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

const makeProbes = Effect.gen(function* () {
  const probes: Probes = {
    layoutSetups: yield* Ref.make<ReadonlyArray<string>>([]),
    postSetups: yield* Ref.make<ReadonlyArray<string>>([]),
    postBuilt: yield* Deferred.make<void>(),
    postClosed: yield* Deferred.make<void>(),
    order: [],
  };
  return probes;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeLocation {
  readonly service: LocationService;
  /** The history operations the router made, as `push /path?search#hash`. */
  readonly history: Array<string>;
}

const makeLocation = (initial: string): Effect.Effect<FakeLocation> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const history: Array<string> = [];
    const write = (kind: string) => (url: URL) =>
      Effect.andThen(
        Ref.set(current, url),
        Effect.sync(() => {
          history.push(`${kind} ${url.pathname}${url.search}${url.hash}`);
        }),
      );
    return {
      service: {
        current: Ref.get(current),
        push: write("push"),
        replace: write("replace"),
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
        mountRouter({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes: [app, LoginRoute],
          notFound: NotFound,
          host,
          root: mountRoot,
        }).pipe(Effect.provideService(Location, location.service)),
    });
    return { page, router: page.setup, receipts: Receipt.of(page.setup), location };
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

const queryRecord = (snapshot: Frame.Snapshot, contractName: string, args: string) =>
  Option.fromNullishOr(
    snapshot.queries.find(
      (one) => one.key.startsWith(`${contractName}@`) && one.key.includes(args),
    ),
  );

const onlyId = (records: ReadonlyArray<{ readonly id: Frame.Identity }>): Frame.Identity => {
  expect(records).toHaveLength(1);
  return Option.getOrThrow(Option.fromNullishOr(records[0]?.id));
};

const actorsAt = (snapshot: Frame.Snapshot, revision: number) =>
  snapshot.actors.filter((one) => one.revision === revision);

const click = (root: HTMLElement, selector: string) =>
  Effect.sync(() => {
    const target = root.querySelector(selector);
    if (target instanceof HTMLElement) {
      target.click();
    }
  });

type Page = Effect.Success<ReturnType<typeof mountApp>>["page"];

const readyPost = (page: Page, tenant: string, postId: string) =>
  page.waitFor({
    label: `post ${tenant}/${postId} content`,
    until: (actual) =>
      textAt(actual, "#post-title") === `value:post:${tenant}/${postId}` &&
      textAt(actual, "#comments") === `value:comments:${tenant}/${postId}` &&
      textAt(actual, "#tenant-name") === `value:tenant:${tenant}`,
  });

const pathOf = (result: Receipt.NavigationResult): string =>
  `${result._tag} ${result.url.pathname}${result.url.search}${result.url.hash}`;

/** The redirect-cycle defect a failed navigation carried. Anything else throws. */
const cycleOf = <A,>(exit: Exit.Exit<A>): Route.RedirectCycle =>
  Schema.decodeUnknownSync(Route.RedirectCycle)(
    Exit.match(exit, {
      onSuccess: () => "committed",
      onFailure: (cause) => Result.getOrElse(Cause.findDefect(cause), () => "no defect"),
    }),
  );

// ---------------------------------------------------------------------------
// Type fixtures. Unannotated expressions only.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RouteServices<T> = T extends AnyRoute<infer R> ? R : never;

const askedOnce = checkTenant({
  params: { tenant: "t1" },
  search: {},
  url: new URL(`${origin}/app/t1`),
  kind: "push",
});
/** A check keeps its services in R, cannot fail, and answers a Verdict. */
const checkServices: Equals<Effect.Services<typeof askedOnce>, Access> = true;
const checkError: Equals<Effect.Error<typeof askedOnce>, never> = true;
const checkSuccess: Equals<
  Effect.Success<typeof askedOnce>,
  Route.Redirect | Route.Continue
> = true;
/** The check's services reach the route; setup E does not. */
const appServices: Equals<
  RouteServices<ReturnType<typeof makeApp>>,
  QueryCache | ActorTransport | Access
> = true;
const failingView = (props: Route.PropsOf<typeof postSegment>) =>
  Effect.flatMap(props.params.get, (params) => PostFailed.make({ postId: params.postId }));
const failingViewError: Equals<Effect.Error<ReturnType<typeof failingView>>, PostFailed> = true;
const typedLeaf = Route.leaf(postSegment, failingView, {
  errored: (failure) => <p>{View.bind(failure, describeFailure)}</p>,
});
const typedLeafServices: Equals<
  Route.PropsOf<typeof postSegment>["data"]["draft"],
  Source<RemoteActorRef<typeof Draft>>
> = true;
/** A segment prints its whole path with its own codecs. */
const printed = Route.redirect(postSegment, { tenant: "t1", postId: "7" }, { tab: "edit" });

// @effect-diagnostics missingEffectError:off
// Thunks: a wrong redirect would fail to print if it ran.
// @ts-expect-error A redirect's params are the destination's params.
const missingParam = () => Route.redirect(postSegment, { tenant: "t1" }, { tab: "read" });

// @ts-expect-error A redirect is checked against its destination's search type.
const wrongSearch = () => Route.redirect(LoginRouteSegment, {}, { next: 1 });

// @ts-expect-error A view that can fail with E needs an errored handler.
const unhandled = Route.leaf(postSegment, failingView);

// @ts-expect-error The handler must take this view's E, not another.
const wrongHandler = Route.leaf(postSegment, failingView, {
  errored: (failure: Source<Route.RouteFailure<LayoutFailed>>) =>
    View.bind(failure, describeFailure),
});

// @ts-expect-error An event cannot fail with a typed error, so it cannot become setup E.
const typedEvent = View.event(() => PostFailed.make({ postId: "x" }));
// @effect-diagnostics missingEffectError:error

const typeFixtures = [
  checkServices,
  checkError,
  checkSuccess,
  appServices,
  failingViewError,
  typedLeafServices,
  typedLeaf,
  printed,
  missingParam,
  wrongSearch,
  unhandled,
  wrongHandler,
  typedEvent,
];

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

describe("private route checks and errors", () => {
  it.effect("0. keeps exact check, target, and failure types", () =>
    Effect.sync(() => {
      expect(typeFixtures.slice(0, 6)).toEqual([true, true, true, true, true, true]);
      expect(printed.href).toBe("/app/t1/posts/7?tab=edit");
    }),
  );

  it.scoped.layer(frameLayer("checks-inputs"))(
    "1. gives every matched segment its decoded target values, parent first, on every branch move",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, receipts, location } = yield* mountApp(
          makeApp(probes),
          root,
          "/app/t1/posts/1?tab=comments",
        );
        yield* readyPost(page, "t1", "1");
        const initial = yield* askedLog();
        expect(initial).toEqual([
          {
            segment: "tenant",
            params: { tenant: "t1" },
            search: {},
            url: `${origin}/app/t1/posts/1?tab=comments`,
            kind: "initial",
          },
          {
            segment: "post",
            params: { tenant: "t1", postId: "1" },
            search: { tab: "comments" },
            url: `${origin}/app/t1/posts/1?tab=comments`,
            kind: "initial",
          },
        ]);

        // A post-ID move keeps the layout, and its check is asked again.
        const moved = yield* receipts.navigate("/app/t1/posts/2");
        expect(pathOf(moved)).toBe("Committed /app/t1/posts/2");
        yield* readyPost(page, "t1", "2");
        // A search refinement is a branch move too.
        yield* receipts.replace("/app/t1/posts/2?tab=edit");
        expect(questions((yield* askedLog()).slice(2))).toEqual([
          "tenant:/app/t1/posts/2:push",
          "post:/app/t1/posts/2:push",
          "tenant:/app/t1/posts/2:replace",
          "post:/app/t1/posts/2:replace",
        ]);

        // A same-URL request and a fragment-only move ask nobody.
        const same = yield* receipts.navigate("/app/t1/posts/2?tab=edit");
        expect(pathOf(same)).toBe("Unchanged /app/t1/posts/2?tab=edit");
        const fragment = yield* receipts.navigate("/app/t1/posts/2?tab=edit#c1");
        expect(pathOf(fragment)).toBe("Committed /app/t1/posts/2?tab=edit#c1");
        expect(yield* askedLog()).toHaveLength(6);
        expect(location.history).toEqual([
          "push /app/t1/posts/2",
          "replace /app/t1/posts/2?tab=edit",
          "push /app/t1/posts/2?tab=edit#c1",
        ]);
        expect(yield* Ref.get(probes.layoutSetups)).toEqual(["t1"]);
      }),
  );

  it.scoped.layer(frameLayer("checks-refusal"))(
    "2. a layout redirect starts no child check, declaration, or setup, and history moves once",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, router, receipts, location } = yield* mountApp(
          makeApp(probes),
          root,
          "/app/t1/posts/1",
        );
        yield* readyPost(page, "t1", "1");
        const before = (yield* askedLog()).length;

        // The decision for t2 is held: nothing of t2 has started, and
        // history has not moved.
        const decision = yield* holdDecision("t2");
        const moving = yield* Effect.forkChild(receipts.navigate("/app/t2/posts/9"));
        yield* Deferred.await(decision.started);
        expect(location.history).toEqual([]);
        expect(yield* callsOf("tenant:t2")).toBe(0);
        expect(yield* callsOf("post:t2/9")).toBe(0);
        expect(questions((yield* askedLog()).slice(before))).toEqual([
          "tenant:/app/t2/posts/9:push",
        ]);
        expect(textAt(root, "#post-title")).toBe("value:post:t1/1");

        yield* deny("t2");
        yield* Deferred.succeed(decision.gate, void 0);
        const result = yield* Fiber.join(moving);
        expect(pathOf(result)).toBe("Committed /login?next=%2Fapp%2Ft2%2Fposts%2F9");
        yield* page.waitFor({
          label: "sign-in page",
          until: (actual) => textAt(actual, "#login") === "/app/t2/posts/9",
        });
        // Exactly one new entry, for the final URL. The denied URL is not a Back entry.
        expect(location.history).toEqual(["push /login?next=%2Fapp%2Ft2%2Fposts%2F9"]);
        // No child check, declaration, or setup for the refused branch.
        expect(questions((yield* askedLog()).slice(before))).toEqual([
          "tenant:/app/t2/posts/9:push",
        ]);
        expect(yield* callsOf("tenant:t2")).toBe(0);
        expect(yield* callsOf("post:t2/9")).toBe(0);
        expect(yield* callsOf("comments:t2/9")).toBe(0);
        expect(yield* subscriptionsOf("t2", "9")).toBe(0);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
        const atLogin = yield* Frame.inspect;
        expect(atLogin.queries).toHaveLength(0);
        expect(atLogin.routes.map((one) => one.routeName)).toEqual(["login"]);

        // A replace that redirects replaces once.
        yield* router.navigate("/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* receipts.replace("/app/t2/posts/3");
        expect(location.history.slice(1)).toEqual([
          "push /app/t1/posts/1",
          "replace /login?next=%2Fapp%2Ft2%2Fposts%2F3",
        ]);
        expect(yield* callsOf("post:t2/3")).toBe(0);
      }),
  );

  it.scoped.layer(frameLayer("checks-initial"))(
    "2b. an initial redirect replaces the entry the document already holds",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        yield* deny("t2");
        const { page, router, location } = yield* mountApp(
          makeApp(probes),
          root,
          "/app/t2/posts/1",
        );
        yield* page.waitFor({
          label: "sign-in page",
          until: (actual) => textAt(actual, "#login") === "/app/t2/posts/1",
        });
        expect(location.history).toEqual(["replace /login?next=%2Fapp%2Ft2%2Fposts%2F1"]);
        expect(questions(yield* askedLog())).toEqual(["tenant:/app/t2/posts/1:initial"]);
        expect(yield* Ref.get(probes.layoutSetups)).toEqual([]);
        expect(yield* callsOf("tenant:t2")).toBe(0);
        const current = yield* router.navigations.get;
        expect(`${current.kind} ${current.url.pathname}`).toBe("initial /login");
      }),
  );

  it.scoped.layer(frameLayer("checks-stayed"))(
    "3. rechecks a stayed protected layout when the tenant or the principal changes",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, receipts, location } = yield* mountApp(
          makeApp(probes),
          root,
          "/app/t1/posts/1",
        );
        yield* readyPost(page, "t1", "1");
        const layoutElement = root.querySelector("#layout");
        const layoutActor = onlyId(actorsAt(yield* Frame.inspect, LayoutRevision));

        // The layout stays for t2; its check is asked with the new tenant.
        yield* receipts.navigate("/app/t2/posts/1");
        yield* readyPost(page, "t2", "1");
        expect(root.querySelector("#layout")).toBe(layoutElement);
        expect(onlyId(actorsAt(yield* Frame.inspect, LayoutRevision))).toBe(layoutActor);
        expect(yield* Ref.get(probes.layoutSetups)).toEqual(["t1"]);
        expect(questions((yield* askedLog()).slice(2))).toEqual([
          "tenant:/app/t2/posts/1:push",
          "post:/app/t2/posts/1:push",
        ]);

        // The principal loses t2. The same stayed layout is asked again and
        // refuses: its earlier answer is not permission.
        yield* deny("t2");
        const refused = yield* receipts.navigate("/app/t2/posts/2");
        expect(pathOf(refused)).toBe("Committed /login?next=%2Fapp%2Ft2%2Fposts%2F2");
        expect(questions((yield* askedLog()).slice(4))).toEqual(["tenant:/app/t2/posts/2:push"]);
        expect(location.history).toEqual([
          "push /app/t2/posts/1",
          "push /login?next=%2Fapp%2Ft2%2Fposts%2F2",
        ]);
        expect(yield* callsOf("post:t2/2")).toBe(0);
        expect(yield* subscriptionsOf("t2", "2")).toBe(0);
      }),
  );

  it.scoped.layer(frameLayer("checks-cycle"))(
    "4. reports a redirect cycle and a runaway chain at the router, and commits nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, receipts, location } = yield* mountApp(
          makeApp(probes),
          root,
          "/app/t1/posts/1",
        );
        yield* readyPost(page, "t1", "1");

        const cycle = yield* Effect.exit(receipts.navigate("/app/t1/posts/loop-a"));
        const repeated = cycleOf(cycle);
        expect(repeated).toMatchObject({
          _tag: "RedirectCycle",
          reason: "repeated",
          chain: [
            `${origin}/app/t1/posts/loop-a`,
            `${origin}/app/t1/posts/loop-b`,
            `${origin}/app/t1/posts/loop-a`,
          ],
        });
        const runaway = yield* Effect.exit(receipts.navigate("/app/t1/posts/step-0"));
        const limit = cycleOf(runaway);
        expect(limit).toMatchObject({ _tag: "RedirectCycle", reason: "limit" });
        expect(limit.chain).toHaveLength(Check.redirectLimit + 2);

        // Nothing moved: no history, no declaration, the same page.
        expect(location.history).toEqual([]);
        expect(yield* callsOf("post:t1/loop-a")).toBe(0);
        expect(yield* callsOf("post:t1/step-1")).toBe(0);
        expect(textAt(root, "#post-param")).toBe("1");
        // The router still serves the next navigation.
        const next = yield* receipts.navigate("/app/t1/posts/2");
        expect(pathOf(next)).toBe("Committed /app/t1/posts/2");
        yield* readyPost(page, "t1", "2");
      }),
  );

  it.scoped.layer(frameLayer("checks-setup-failure"))(
    "5. a failed setup closes before errored shows its typed error; the Frame stays alive",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, receipts } = yield* mountApp(makeApp(probes), root, "/app/t1");
        yield* page.waitFor({
          label: "layout alone",
          until: (actual) => textAt(actual, "#tenant-name") === "value:tenant:t1",
        });
        const before = yield* Frame.inspect;
        const layoutActor = onlyId(actorsAt(before, LayoutRevision));
        const tenantQuery = Option.map(
          queryRecord(before, "CheckedTenantInfo", "t1"),
          (one) => one.id,
        );

        yield* receipts.navigate("/app/t1/posts/bad");
        yield* page.waitFor({
          label: "the post's errored node",
          until: (actual) => textAt(actual, "#post-errored") === "Setup:PostFailed",
        });
        // The failed setup closed before errored was built.
        expect(probes.order).toEqual(["setup-closed", "errored-built"]);
        yield* Deferred.await(probes.postClosed);
        const failed = yield* Frame.inspect;
        // The failed setup's local actor and the segment's own interests are gone.
        expect(actorsAt(failed, PostRevision)).toHaveLength(0);
        expect(Option.isNone(queryRecord(failed, "CheckedPostBody", "bad"))).toBe(true);
        expect(Option.isNone(queryRecord(failed, "CheckedComments", "bad"))).toBe(true);
        expect(yield* subscriptionsOf("t1", "bad")).toBe(0);
        // The layout and the Frame are alive.
        expect(onlyId(actorsAt(failed, LayoutRevision))).toBe(layoutActor);
        expect(Option.map(queryRecord(failed, "CheckedTenantInfo", "t1"), (one) => one.id)).toEqual(
          tenantQuery,
        );
        expect(failed.mounts).toHaveLength(1);
        expect(failed.routes.map((one) => one.routeName)).toEqual(["app"]);

        // A new non-no-op navigation enters the failed segment again.
        yield* receipts.navigate("/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        expect(hasAt(root, "#post-errored")).toBe(false);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["bad", "1"]);
        expect(yield* Ref.get(probes.layoutSetups)).toEqual(["t1"]);
      }),
  );

  it.scoped.layer(frameLayer("checks-root-failure"))(
    "5b. a failed root layout shows errored, and the next move enters the tree again",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, receipts } = yield* mountApp(makeApp(probes), root, "/app/broken");
        yield* page.waitFor({
          label: "the layout's errored node",
          until: (actual) => textAt(actual, "#layout-errored") === "Setup:LayoutFailed",
        });
        const failed = yield* Frame.inspect;
        expect(Option.isNone(queryRecord(failed, "CheckedTenantInfo", "broken"))).toBe(true);
        expect(failed.mounts).toHaveLength(1);

        yield* receipts.navigate("/app/t1");
        yield* page.waitFor({
          label: "the t1 layout",
          until: (actual) =>
            textAt(actual, "#tenant-name") === "value:tenant:t1" &&
            !hasAt(actual, "#layout-errored"),
        });
        expect(yield* Ref.get(probes.layoutSetups)).toEqual(["broken", "t1"]);
        const entered = yield* Frame.inspect;
        expect(entered.mounts).toHaveLength(1);
        expect(entered.routes).toHaveLength(1);
      }),
  );

  it.scoped.layer(frameLayer("checks-declaration-failure"))(
    "6. an own declaration failure takes the Declaration branch; siblings are released",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, receipts } = yield* mountApp(makeApp(probes), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        const layoutElement = root.querySelector("#layout");

        yield* failSnapshot("t1", "b");
        const result = yield* receipts.navigate("/app/t1/posts/b");
        expect(pathOf(result)).toBe("Committed /app/t1/posts/b");
        yield* page.waitFor({
          label: "the post's declaration errored node",
          until: (actual) =>
            textAt(actual, "#post-errored") === "Declaration:ActorStopped" &&
            !hasAt(actual, "#post"),
        });
        // The stayed post view was replaced: it closed, and no setup ran for b.
        yield* Deferred.await(probes.postClosed);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
        expect(probes.order).toEqual(["errored-built"]);
        const failed = yield* Frame.inspect;
        expect(Option.isNone(queryRecord(failed, "CheckedPostBody", '"postId":"b"'))).toBe(true);
        expect(Option.isNone(queryRecord(failed, "CheckedComments", '"postId":"b"'))).toBe(true);
        expect(Option.isNone(queryRecord(failed, "CheckedPostBody", '"postId":"1"'))).toBe(true);
        expect(yield* subscriptionsOf("t1", "1")).toBe(0);
        expect(yield* subscriptionsOf("t1", "b")).toBe(0);
        expect(root.querySelector("#layout")).toBe(layoutElement);
        expect(yield* Ref.get(probes.layoutSetups)).toEqual(["t1"]);

        // The failed instance is entered again on the next move.
        yield* receipts.navigate("/app/t1/posts/2");
        yield* readyPost(page, "t1", "2");
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1", "2"]);
      }),
  );

  it.scoped.layer(frameLayer("checks-later-failures"))(
    "7. a later query failure and an event failure are not route setup failures",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const wire = yield* Wire;
        const comments = yield* holdQuery("comments:t1/1");
        yield* failQuery("comments:t1/1");
        const { page } = yield* mountApp(makeApp(probes), root, "/app/t1/posts/1");
        yield* Deferred.await(probes.postBuilt);
        yield* Deferred.await(comments.started);
        yield* page.waitFor({
          label: "set up, with comments still loading",
          until: (actual) =>
            textAt(actual, "#post-title") === "value:post:t1/1" &&
            textAt(actual, "#comments") === "loading",
        });
        const postElement = root.querySelector("#post");

        // The query fails after setup: its own Query branch shows it.
        yield* Deferred.succeed(comments.gate, void 0);
        yield* page.waitFor({
          label: "the comments Query failed branch",
          until: (actual) => textAt(actual, "#comments") === "failed",
        });
        expect(hasAt(root, "#post-errored")).toBe(false);

        // An event dies. The view stays, is not recast as errored, and still acts.
        yield* click(root, "#boom");
        yield* click(root, "#current");
        expect(yield* Queue.take(wire.commands)).toBe(draftKey("t1", "1"));
        expect(hasAt(root, "#post-errored")).toBe(false);
        expect(root.querySelector("#post")).toBe(postElement);
        expect(yield* Ref.get(probes.postSetups)).toEqual(["1"]);
        expect(probes.order).toEqual([]);
      }),
  );

  it.scoped.layer(frameLayer("checks-close"))(
    "8. a root close during a held check interrupts the receipt and leaks nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const { page, receipts, location } = yield* mountApp(
          makeApp(probes),
          root,
          "/app/t1/posts/1",
        );
        yield* readyPost(page, "t1", "1");
        const decision = yield* holdDecision("t3");
        const moving = yield* Effect.forkChild(receipts.navigate("/app/t3/posts/1"));
        yield* Deferred.await(decision.started);

        yield* page.close;
        const exit = yield* Fiber.await(moving);
        // Interrupted, never a false Committed.
        expect(Exit.hasInterrupts(exit)).toBe(true);
        yield* Deferred.succeed(decision.gate, void 0);
        expect(location.history).toEqual([]);
        expect(yield* callsOf("tenant:t3")).toBe(0);
        const closed = yield* Frame.inspect;
        expect(closed.actors.filter((one) => one.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
      }),
  );
});
