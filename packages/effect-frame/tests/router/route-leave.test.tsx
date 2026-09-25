import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorTransport,
  Behavior,
  CommandId,
  contract,
  implementQuery,
  implementTransparent,
  query as queryContract,
  Policies,
  Policy as AccessPolicy,
  ActorHost,
  QueryCache,
} from "effect-frame/actor";
import type { RemoteActorRef, Source, TransportService } from "effect-frame/actor";
import { Location, Route, mount as mountRouter, NavigationBehavior } from "effect-frame/router";
import type { LocationService, NavigationResult } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import * as Frame from "../../src/frame.js";
import * as LeaveBranch from "../../src/router/leave-branch.js";
import * as Leave from "../../src/router/leave.js";
import * as Traversal from "../../src/router/traversal.js";
import { withCapabilities } from "../../src/router/landing.js";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";

/**
 * The one policy table: every contract and query here declares `public`.
 * The import is renamed because this file's own `Policy` is the leave policy.
 */
const policies = Layer.succeed(Policies, Policies.of({ public: AccessPolicy.allowAll }));

// ---------------------------------------------------------------------------
// Contracts and a real in-process host
// ---------------------------------------------------------------------------

const TenantInfo = queryContract("LeaveTenantInfo", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.String,
  depends: [],
});

const PostBody = queryContract("LeavePostBody", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
  depends: [],
});

const SetText = Schema.TaggedStruct("SetText", { text: Schema.String });
type SetText = Schema.Schema.Type<typeof SetText>;

const Draft = contract("LeaveDraft", {
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

interface CallsService {
  readonly calls: Ref.Ref<ReadonlyMap<string, number>>;
}

class Calls extends Context.Service<Calls, CallsService>()(
  "effect-frame/tests/router/route-leave.test/Calls",
) {}

const serve = Effect.fn("LeaveTest.serve")(function* (id: string) {
  const calls = yield* Calls;
  yield* Ref.update(calls.calls, (all) => {
    const next = new Map(all);
    next.set(id, Option.getOrElse(Option.fromNullishOr(all.get(id)), () => 0) + 1);
    return next;
  });
  return `value:${id}`;
});

const TenantLive = implementQuery(TenantInfo, { run: ({ tenant }) => serve(`tenant:${tenant}`) });
const PostLive = implementQuery(PostBody, {
  run: ({ tenant, postId }) => serve(`post:${tenant}/${postId}`),
});

interface WireService {
  readonly commands: Queue.Queue<string>;
}

class Wire extends Context.Service<Wire, WireService>()(
  "effect-frame/tests/router/route-leave.test/Wire",
) {}

const wired = Layer.effect(
  ActorTransport,
  Effect.gen(function* () {
    const inner = yield* ActorTransport;
    const wire = yield* Wire;
    const service: TransportService = {
      ...inner,
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
// The leave policy the views' checks consult
// ---------------------------------------------------------------------------

/** How one labelled check answers. `dialog` holds the answer in a prompt. */
type Mode = "leave" | "stay" | "refine" | "dialog" | "die";

interface Prompt {
  readonly label: string;
  readonly question: number;
  readonly answer: Deferred.Deferred<Leave.LeaveVerdict>;
}

interface PolicyService {
  /** Every question, as `label:previous->next:kind`. */
  readonly asked: Array<string>;
  /** Every question's Scope close, as `label#question`. */
  readonly closed: Array<string>;
  readonly modes: Map<string, Mode>;
  readonly prompts: Queue.Queue<Prompt>;
  /** Labels of the post instances, in setup order. */
  readonly posts: Array<string>;
  count: number;
}

class Policy extends Context.Service<Policy, PolicyService>()(
  "effect-frame/tests/router/route-leave.test/Policy",
) {}

const makePolicy = Effect.gen(function* () {
  const policy: PolicyService = {
    asked: [],
    closed: [],
    modes: new Map(),
    prompts: yield* Queue.unbounded<Prompt>(),
    posts: [],
    count: 0,
  };
  return Policy.of(policy);
});

const client = Layer.merge(
  QueryCache.layer,
  ActorHost.layer({
    queries: [TenantLive, PostLive],
    implementations: [DraftLive],
    store: ActorHost.memoryStore,
  }),
).pipe(Layer.provide(policies));

const frameLayer = (name: string) =>
  Layer.mergeAll(client, wired.pipe(Layer.provide(client))).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(
          Calls,
          Effect.map(Ref.make<ReadonlyMap<string, number>>(new Map()), (calls) => ({ calls })),
        ),
        Layer.effect(
          Wire,
          Effect.map(Queue.unbounded<string>(), (commands) => ({ commands })),
        ),
        Layer.effect(Policy, makePolicy),
      ),
    ),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Frame.layer({ name })),
  );

/** The fixture's decoded values are string records. */
const decodeStrings = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String));

/** A decoded record as `key=value,…`. */
const printRecord = (record: Readonly<Record<string, string>>): string =>
  Object.entries(record)
    .map(([key, one]) => `${key}=${one}`)
    .join(",");

const printValues = (values: Route.Values<unknown, unknown>): string =>
  [values.params, values.search]
    .map((one) =>
      Option.match(decodeStrings(one), { onNone: () => "<not strings>", onSome: printRecord }),
    )
    .join("|");

const describeInput = (input: Leave.LeaveInput<unknown, unknown>): string =>
  `${printValues(input.previous)}->${Option.match(input.next, {
    onNone: () => "exit",
    onSome: printValues,
  })}:${new URL(input.destination).pathname}${new URL(input.destination).search}:${input.kind}`;

/**
 * One check. `refine` answers per the typed values: it permits a move that
 * keeps the post ID and refuses any other. Its Scope close is recorded.
 */
const check =
  (label: string, refine: (input: Leave.LeaveInput<unknown, unknown>) => boolean) =>
  (input: Leave.LeaveInput<unknown, unknown>) =>
    Effect.gen(function* () {
      const policy = yield* Policy;
      policy.count += 1;
      const question = policy.count;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          policy.closed.push(`${label}#${String(question)}`);
        }),
      );
      policy.asked.push(`${label}:${describeInput(input)}`);
      const mode = Option.getOrElse(Option.fromNullishOr(policy.modes.get(label)), () => "leave");
      if (mode === "stay") {
        return Leave.Stay;
      }
      if (mode === "die") {
        return yield* Effect.die("the check died");
      }
      if (mode === "refine") {
        if (refine(input)) {
          return Leave.Leave;
        }
        return Leave.Stay;
      }
      if (mode === "dialog") {
        const answer = yield* Deferred.make<Leave.LeaveVerdict>();
        const dialog = document.createElement("dialog");
        dialog.id = `dialog-${String(question)}`;
        document.body.append(dialog);
        yield* Effect.addFinalizer(() => Effect.sync(() => dialog.remove()));
        yield* Queue.offer(policy.prompts, { label, question, answer });
        return yield* Deferred.await(answer);
      }
      return Leave.Leave;
    });

// ---------------------------------------------------------------------------
// The tenant/post tree with scoped checks
// ---------------------------------------------------------------------------

const TenantParams = Schema.Struct({ tenant: Schema.String });
const tenantSegment = Route.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Route.query(TenantInfo, { tenant: params.tenant }) }),
});

const postSegment = Route.child(tenantSegment, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ postId: Schema.String }),
  search: Route.search(Schema.Struct({ tab: Schema.String.pipe(Route.withDefault("read")) })),
  data: ({ params }) => ({
    draft: Route.actor(Draft, { tenant: params.tenant, postId: params.postId }),
    post: Route.query(PostBody, { tenant: params.tenant, postId: params.postId }),
  }),
});

const settingsSegment = Route.child(tenantSegment, "settings", {
  path: "settings",
});

/** Permit a move that keeps this post: a search refinement. */
const samePost = (
  input: Leave.LeaveInput<
    { readonly tenant: string; readonly postId: string },
    { readonly tab: string }
  >,
): boolean =>
  Option.exists(input.next, (next) => next.params.postId === input.previous.params.postId);

/** The post's check, typed by its owner. */
const postCheck = (label: string) =>
  check(label, (input) =>
    samePost(
      // oxlint-disable-next-line effect/noAs -- the test's shared recorder takes erased input; onLeave typed the real one.
      input as Leave.LeaveInput<
        { readonly tenant: string; readonly postId: string },
        { readonly tab: string }
      >,
    ),
  );

let commandCounter = 0;
const nextCommandId = () => {
  commandCounter += 1;
  return Schema.decodeSync(CommandId)(`leave-${String(commandCounter)}`);
};

const sendText = (target: RemoteActorRef<typeof Draft>, text: string) =>
  Effect.orDie(target.send(SetText.make({ text }), { commandId: nextCommandId() }));

class PostFailed extends Schema.TaggedError<PostFailed>()("PostFailed", {
  postId: Schema.String,
}) {}

const PostView = (props: Route.PropsOf<typeof postSegment>) =>
  Effect.gen(function* () {
    const policy = yield* Policy;
    const label = `post#${String(policy.posts.length + 1)}`;
    policy.posts.push(label);
    yield* Leave.onLeave(postSegment, (input) => postCheck(label)(input));
    const first = yield* props.params.get;
    if (first.postId === "bad") {
      // Registered, then failed: the failed setup's Scope closes its check.
      return yield* PostFailed.make({ postId: first.postId });
    }
    const title = yield* View.ready(props.data.post.state, "");
    return (
      <article id="post">
        <h2 id="post-title">{View.bind(title)}</h2>
        <p id="post-param">{View.bind(props.params, (params) => params.postId)}</p>
        <p id="post-tab">{View.bind(props.search, (search) => search.tab)}</p>
        <textarea id="draft" />
        <button
          id="send"
          onClick={View.event(
            Effect.flatMap(props.data.draft.ref.get, (current) => sendText(current, "typed")),
          )}
        >
          send
        </button>
      </article>
    );
  });

const SettingsView = () => Effect.succeed(<p id="settings">settings</p>);

const makeApp = () =>
  Route.client(
    "app",
    LeaveBranch.layout(
      tenantSegment,
      [
        LeaveBranch.leaf(postSegment, PostView, {
          errored: () => <p id="post-errored">errored</p>,
        }),
        LeaveBranch.leaf(settingsSegment, SettingsView),
      ],
      (props) =>
        Effect.gen(function* () {
          const params = yield* props.params.get;
          yield* Leave.onLeave(
            tenantSegment,
            check(`tenant:${params.tenant}`, () => true),
          );
          const body = yield* View.loading({
            fallback: <p id="child-loading">loading child</p>,
            content: Effect.map(props.outlet, (outlet) => <div id="outlet">{outlet}</div>),
          });
          return (
            <section id="layout">
              <p id="tenant-param">{View.bind(props.params, (value) => value.tenant)}</p>
              {body}
            </section>
          );
        }),
    ),
  );

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

// ---------------------------------------------------------------------------
// Harness: the fixture Location with pops and pre-commit traversals
// ---------------------------------------------------------------------------

interface FakeLocation {
  readonly service: LocationService;
  /** The history operations, as `push /path?search`. */
  readonly history: Array<string>;
  readonly current: Ref.Ref<URL>;
  readonly pops: Queue.Queue<URL>;
  readonly traversals: Traversal.TraversalSource;
}

const origin = "http://frame.test";

const makeLocation = (initial: string): Effect.Effect<FakeLocation> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const history: Array<string> = [];
    const pops = yield* Queue.unbounded<URL>();
    const traversals = yield* Traversal.makeSource;
    const write = (kind: string) => (url: URL) =>
      Effect.andThen(
        Ref.set(current, url),
        Effect.sync(() => {
          history.push(`${kind} ${url.pathname}${url.search}`);
        }),
      );
    const service = withCapabilities(
      {
        current: Ref.get(current),
        push: write("push"),
        replace: write("replace"),
        pops: Stream.fromQueue(pops),
      },
      { surface: Option.none(), traversals: Option.some(traversals) },
    );
    return { service, history, current, pops, traversals };
  });

/** A traversal the fixture platform commits only when the router lets it. */
interface FixtureTraversal {
  readonly traversal: Traversal.Traversal;
  /** True: the router let it commit. False: it stayed. */
  readonly answered: Deferred.Deferred<boolean>;
  readonly finished: Deferred.Deferred<void>;
  /** Complete it to abandon the traversal, as the platform would. */
  readonly abandon: Deferred.Deferred<void>;
}

const makeTraversal = (
  location: FakeLocation,
  path: string,
  protection: Traversal.Traversal["protection"],
) =>
  Effect.gen(function* () {
    const answered = yield* Deferred.make<boolean>();
    const finished = yield* Deferred.make<void>();
    const abandon = yield* Deferred.make<void>();
    const destination = new URL(`${origin}${path}`);
    const commit = Effect.gen(function* () {
      if (yield* Deferred.succeed(answered, true)) {
        yield* Ref.set(location.current, destination);
        location.history.push(`traverse ${path}`);
      }
      return true;
    });
    const traversal: Traversal.Traversal = {
      destination,
      protection,
      stay: Effect.asVoid(Deferred.succeed(answered, false)),
      leave: commit,
      abandoned: Deferred.await(abandon),
      land: () => Effect.void,
      finish: Effect.andThen(Effect.asVoid(commit), Deferred.succeed(finished, void 0)),
    };
    const made: FixtureTraversal = { traversal, answered, finished, abandon };
    return made;
  });

const makeRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const created = document.createElement("main");
    document.body.appendChild(created);
    return created;
  }),
  (created) => Effect.sync(() => created.remove()),
);

const mountApp = <R,>(app: Route.AnyRoute<R>, root: HTMLElement, path: string) =>
  Effect.gen(function* () {
    const location = yield* makeLocation(`${origin}${path}`);
    const logs: Array<string> = [];
    const collector = Logger.make((options) => {
      logs.push(`${options.logLevel} ${String(options.message)}`);
    });
    const page = yield* ViewTest.make({
      host: Dom.host,
      root,
      setup: (host, mountRoot) =>
        mountRouter({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes: [app],
          notFound: NotFound,
          host,
          root: mountRoot,
        }).pipe(
          Effect.provideService(Location, location.service),
          Effect.provideService(Logger.CurrentLoggers, new Set([collector])),
        ),
    });
    return { page, router: page.setup, location, logs };
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
    label: `post ${tenant}/${postId}`,
    until: (actual) =>
      textAt(actual, "#post-title") === `value:post:${tenant}/${postId}` &&
      textAt(actual, "#tenant-param") === tenant,
  });

const pathOf = (result: NavigationResult): string =>
  `${result._tag} ${result.url.pathname}${result.url.search}`;

const callsOf = Effect.fn("LeaveTest.callsOf")(function* (id: string) {
  const calls = yield* Calls;
  return Option.getOrElse(Option.fromNullishOr((yield* Ref.get(calls.calls)).get(id)), () => 0);
});

const hasQuery = (snapshot: Frame.Snapshot, args: string): boolean =>
  snapshot.queries.some((one) => one.key.startsWith("LeavePostBody@") && one.key.includes(args));

const setMode = Effect.fn("LeaveTest.setMode")(function* (label: string, mode: Mode) {
  const policy = yield* Policy;
  policy.modes.set(label, mode);
});

const post1 = "tenant=t1,postId=1|tab=read";
const post2 = "tenant=t1,postId=2|tab=read";

// ---------------------------------------------------------------------------
// Type fixtures. Unannotated expressions only.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RouteServices<T> = T extends Route.AnyRoute<infer R> ? R : never;

const registered = Leave.onLeave(postSegment, (input) =>
  Effect.map(Effect.service(Policy), () => {
    const previous: Equals<
      typeof input.previous.params,
      { readonly tenant: string; readonly postId: string }
    > = true;
    const next: Equals<
      typeof input.next,
      Option.Option<
        Route.Values<{ readonly tenant: string; readonly postId: string }, { readonly tab: string }>
      >
    > = true;
    if (previous && next) {
      return Leave.Stay;
    }
    return Leave.Leave;
  }),
);
/** A registration needs the mounted owner, a Scope, and the check's services. */
const registrationServices: Equals<
  Effect.Services<typeof registered>,
  Leave.MountedRoute | Scope.Scope | Policy
> = true;
/** The instance provides MountedRoute: the route needs only data and the check's services. */
const appServices: Equals<
  RouteServices<ReturnType<typeof makeApp>>,
  QueryCache | ActorTransport | Policy
> = true;

const typeFixtures = [registrationServices, appServices];

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

describe("private scoped leave checks", () => {
  it.effect("0. keeps exact registration and route types", () =>
    Effect.sync(() => {
      expect(typeFixtures).toEqual([true, true]);
    }),
  );

  it.scoped.layer(frameLayer("leave-stay"))(
    "1. Stay keeps the URL, declarations, DOM, and focus; then Leave commits once",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        const postElement = root.querySelector("#post");
        const draft = root.querySelector("#draft");
        if (!(draft instanceof HTMLTextAreaElement)) {
          return yield* Effect.die("no draft field");
        }
        draft.value = "unsaved words";
        draft.focus();
        draft.setSelectionRange(3, 7);

        yield* setMode("post#1", "stay");
        const stayed = yield* router.push("/app/t1/posts/2");
        expect(pathOf(stayed)).toBe("Stayed /app/t1/posts/1");
        // The unchanged layout is not asked; the post is asked with its next values.
        expect(policy.asked).toEqual([`post#1:${post1}->${post2}:/app/t1/posts/2:push`]);
        expect(location.history).toEqual([]);
        expect((yield* router.current.get).url.pathname).toBe("/app/t1/posts/1");
        // No destination declaration opened.
        expect(yield* callsOf("post:t1/2")).toBe(0);
        const held = yield* Frame.inspect;
        expect(hasQuery(held, '"postId":"2"')).toBe(false);
        expect(hasQuery(held, '"postId":"1"')).toBe(true);
        // The same view, draft, and focus.
        expect(root.querySelector("#post")).toBe(postElement);
        expect(root.querySelector("#draft")).toBe(draft);
        expect(draft.value).toBe("unsaved words");
        expect(document.activeElement).toBe(draft);
        expect([draft.selectionStart, draft.selectionEnd]).toEqual([3, 7]);
        expect(policy.posts).toEqual(["post#1"]);

        yield* setMode("post#1", "leave");
        const left = yield* router.push("/app/t1/posts/2");
        expect(pathOf(left)).toBe("Committed /app/t1/posts/2");
        yield* readyPost(page, "t1", "2");
        expect(location.history).toEqual(["push /app/t1/posts/2"]);
        expect(policy.asked).toHaveLength(2);
        // The post stayed: setup ran once, and its params moved.
        expect(policy.posts).toEqual(["post#1"]);
        expect(yield* callsOf("post:t1/2")).toBe(1);
      }),
  );

  it.scoped.layer(frameLayer("leave-refine"))(
    "2. a stayed post-ID change is refused and a search refinement is allowed",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "refine");

        const refined = yield* router.replace("/app/t1/posts/1?tab=comments");
        expect(pathOf(refined)).toBe("Committed /app/t1/posts/1?tab=comments");
        yield* page.waitFor({
          label: "the comments tab",
          until: (actual) => textAt(actual, "#post-tab") === "comments",
        });
        const refused = yield* router.push("/app/t1/posts/2?tab=comments");
        expect(pathOf(refused)).toBe("Stayed /app/t1/posts/1?tab=comments");
        expect(policy.asked).toEqual([
          `post#1:${post1}->tenant=t1,postId=1|tab=comments:/app/t1/posts/1?tab=comments:replace`,
          `post#1:tenant=t1,postId=1|tab=comments->tenant=t1,postId=2|tab=comments:/app/t1/posts/2?tab=comments:push`,
        ]);
        expect(location.history).toEqual(["replace /app/t1/posts/1?tab=comments"]);
        expect(textAt(root, "#post-param")).toBe("1");
      }),
  );

  it.scoped.layer(frameLayer("leave-order"))(
    "3. asks the deepest instance first and stops at the first Stay",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");

        // The post refuses: the tenant layout is never asked.
        yield* setMode("post#1", "stay");
        expect(pathOf(yield* router.push("/app/t2/posts/1"))).toBe("Stayed /app/t1/posts/1");
        expect(policy.asked.map((one) => one.split(":")[0])).toEqual(["post#1"]);

        // The post permits; the layout is asked next, and refuses.
        yield* setMode("post#1", "leave");
        yield* setMode("tenant:t1", "stay");
        expect(pathOf(yield* router.push("/app/t2/posts/1"))).toBe("Stayed /app/t1/posts/1");
        expect(policy.asked.map((one) => one.split(":")[0])).toEqual([
          "post#1",
          "post#1",
          "tenant",
        ]);
        expect(policy.asked[2]).toBe("tenant:t1:tenant=t1|->tenant=t2|:/app/t2/posts/1:push");

        // Both permit: one commit.
        yield* setMode("tenant:t1", "leave");
        expect(pathOf(yield* router.push("/app/t2/posts/1"))).toBe("Committed /app/t2/posts/1");
        yield* readyPost(page, "t2", "1");
        expect(location.history).toEqual(["push /app/t2/posts/1"]);
      }),
  );

  it.scoped.layer(frameLayer("leave-stale"))(
    "4. a newer navigation supersedes a held prompt; the stale answer decides nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "dialog");

        const first = yield* Effect.forkChild(router.push("/app/t1/posts/2"));
        const firstPrompt = yield* Queue.take(policy.prompts);
        expect(hasAt(document.body, `#dialog-${String(firstPrompt.question)}`)).toBe(true);

        const second = yield* Effect.forkChild(router.push("/app/t1/posts/3"));
        // The first prompt is interrupted: its dialog Scope closed.
        expect(pathOf(yield* Fiber.join(first))).toBe("Unchanged /app/t1/posts/1");
        const secondPrompt = yield* Queue.take(policy.prompts);
        expect(policy.closed).toEqual([`post#1#${String(firstPrompt.question)}`]);
        expect(hasAt(document.body, `#dialog-${String(firstPrompt.question)}`)).toBe(false);

        // The stale answer comes late. It moves nothing, and the new prompt still waits.
        yield* Deferred.succeed(firstPrompt.answer, Leave.Leave);
        expect(Option.isNone(Option.fromNullishOr(second.pollUnsafe()))).toBe(true);
        expect(location.history).toEqual([]);

        yield* Deferred.succeed(secondPrompt.answer, Leave.Stay);
        expect(pathOf(yield* Fiber.join(second))).toBe("Stayed /app/t1/posts/1");
        expect(location.history).toEqual([]);
        expect(textAt(root, "#post-param")).toBe("1");
        expect(policy.closed).toEqual([
          `post#1#${String(firstPrompt.question)}`,
          `post#1#${String(secondPrompt.question)}`,
        ]);
        expect(hasAt(document.body, "dialog")).toBe(false);
      }),
  );

  it.scoped.layer(frameLayer("leave-close"))(
    "5. a root close during a held dialog asks nothing more and leaks nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "dialog");
        const moving = yield* Effect.forkChild(router.push("/app/t2/posts/1"));
        const prompt = yield* Queue.take(policy.prompts);

        yield* page.close;
        const exit = yield* Fiber.await(moving);
        expect(Exit.hasInterrupts(exit)).toBe(true);
        // The dialog's Scope closed; close itself asked nothing.
        expect(policy.closed).toEqual([`post#1#${String(prompt.question)}`]);
        expect(policy.asked).toHaveLength(1);
        expect(hasAt(document.body, "dialog")).toBe(false);
        yield* Deferred.succeed(prompt.answer, Leave.Leave);
        expect(location.history).toEqual([]);
        expect(yield* callsOf("tenant:t2")).toBe(0);
        const closed = yield* Frame.inspect;
        expect(closed.actors.filter((one) => one.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
      }),
  );

  it.scoped.layer(frameLayer("leave-action"))(
    "6. a route action during a held prompt commands the committed target",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const wire = yield* Wire;
        const { page, router } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        const key = (postId: string) => Schema.encodeSync(Draft.key)({ tenant: "t1", postId });

        yield* setMode("post#1", "dialog");
        const moving = yield* Effect.forkChild(router.push("/app/t1/posts/2"));
        const prompt = yield* Queue.take(policy.prompts);
        yield* click(root, "#send");
        expect(yield* Queue.take(wire.commands)).toBe(key("1"));

        yield* Deferred.succeed(prompt.answer, Leave.Stay);
        expect(pathOf(yield* Fiber.join(moving))).toBe("Stayed /app/t1/posts/1");
        yield* click(root, "#send");
        expect(yield* Queue.take(wire.commands)).toBe(key("1"));

        yield* setMode("post#1", "leave");
        expect(pathOf(yield* router.push("/app/t1/posts/2"))).toBe("Committed /app/t1/posts/2");
        yield* readyPost(page, "t1", "2");
        yield* click(root, "#send");
        expect(yield* Queue.take(wire.commands)).toBe(key("2"));
      }),
  );

  it.scoped.layer(frameLayer("leave-replacement"))(
    "7. a check of a replaced instance never vetoes its replacement",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");

        // The first post exits: it is asked with no next values.
        expect(pathOf(yield* router.push("/app/t1/settings"))).toBe("Committed /app/t1/settings");
        expect(policy.asked).toEqual([`post#1:${post1}->exit:/app/t1/settings:push`]);
        yield* page.waitFor({
          label: "settings",
          until: (actual) => hasAt(actual, "#settings"),
        });

        // Its check would now refuse everything. A new instance replaces it.
        yield* setMode("post#1", "stay");
        yield* router.push("/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        expect(policy.posts).toEqual(["post#1", "post#2"]);

        expect(pathOf(yield* router.push("/app/t1/settings"))).toBe("Committed /app/t1/settings");
        expect(policy.asked).toEqual([
          `post#1:${post1}->exit:/app/t1/settings:push`,
          `post#2:${post1}->exit:/app/t1/settings:push`,
        ]);

        // A setup that registered and then failed leaves no check behind.
        yield* router.push("/app/t1/posts/bad");
        yield* page.waitFor({
          label: "the failed post",
          until: (actual) => hasAt(actual, "#post-errored"),
        });
        expect(policy.posts).toEqual(["post#1", "post#2", "post#3"]);
        yield* setMode("post#3", "stay");
        expect(pathOf(yield* router.push("/app/t1/settings"))).toBe("Committed /app/t1/settings");
        expect(policy.asked).toHaveLength(2);
      }),
  );

  it.scoped.layer(frameLayer("leave-scopes"))(
    "8. a check's temporary Scope closes on every result",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");

        yield* setMode("post#1", "stay");
        yield* router.push("/app/t1/posts/2");
        expect(policy.closed).toEqual(["post#1#1"]);

        yield* setMode("post#1", "dialog");
        const held = yield* Effect.forkChild(router.push("/app/t1/posts/2"));
        const prompt = yield* Queue.take(policy.prompts);
        expect(policy.closed).toEqual(["post#1#1"]);
        yield* Deferred.succeed(prompt.answer, Leave.Leave);
        expect(pathOf(yield* Fiber.join(held))).toBe("Committed /app/t1/posts/2");
        expect(policy.closed).toEqual(["post#1#1", "post#1#2"]);

        yield* setMode("post#1", "leave");
        yield* router.push("/app/t1/posts/3");
        expect(policy.closed).toEqual(["post#1#1", "post#1#2", "post#1#3"]);
        // The view's own Scope is untouched: the same instance still shows.
        yield* readyPost(page, "t1", "3");
        expect(policy.posts).toEqual(["post#1"]);
      }),
  );

  it.scoped.layer(frameLayer("leave-traversal"))(
    "9. a protected traversal is asked before commit; an unprotected one is followed and reported",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, location, logs } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "stay");

        // Protected: asked with kind pop, refused, and the platform never commits.
        const refused = yield* makeTraversal(location, "/app/t1/posts/2", "precommit");
        yield* location.traversals.offer(refused.traversal);
        expect(yield* Deferred.await(refused.answered)).toBe(false);
        yield* Deferred.await(refused.finished);
        expect(policy.asked).toEqual([`post#1:${post1}->${post2}:/app/t1/posts/2:pop`]);
        expect(location.history).toEqual([]);
        expect(textAt(root, "#post-param")).toBe("1");

        // Protected and permitted: one commit, then the router shows it.
        yield* setMode("post#1", "leave");
        const permitted = yield* makeTraversal(location, "/app/t1/posts/2", "cancel");
        yield* location.traversals.offer(permitted.traversal);
        expect(yield* Deferred.await(permitted.answered)).toBe(true);
        yield* Deferred.await(permitted.finished);
        yield* readyPost(page, "t1", "2");
        expect(location.history).toEqual(["traverse /app/t1/posts/2"]);

        // Unprotected: not asked, followed, and reported.
        yield* setMode("post#1", "stay");
        const forced = yield* makeTraversal(location, "/app/t1/posts/3", "none");
        yield* location.traversals.offer(forced.traversal);
        yield* Deferred.await(forced.finished);
        yield* readyPost(page, "t1", "3");
        yield* Ref.set(location.current, new URL(`${origin}/app/t1/posts/4`));
        yield* Queue.offer(location.pops, new URL(`${origin}/app/t1/posts/4`));
        yield* readyPost(page, "t1", "4");
        expect(policy.asked).toHaveLength(2);
        expect(logs).toEqual([
          `Warn route.leave.unprotected url=${origin}/app/t1/posts/3 kind=pop checks=1 reason=noncancelable`,
          `Warn route.leave.unprotected url=${origin}/app/t1/posts/4 kind=pop checks=1 reason=committed`,
        ]);
      }),
  );

  it.scoped.layer(frameLayer("leave-defect"))(
    "11. a defect during a protected traversal refuses it; the router keeps working",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "die");

        const protections: ReadonlyArray<Traversal.Traversal["protection"]> = [
          "precommit",
          "cancel",
        ];
        for (const protection of protections) {
          const dying = yield* makeTraversal(location, "/app/t1/posts/2", protection);
          yield* location.traversals.offer(dying.traversal);
          yield* Deferred.await(dying.finished);
          // Refused before it was let through: the URL and the view agree.
          expect(yield* Deferred.await(dying.answered)).toBe(false);
        }
        expect(location.history).toEqual([]);
        expect((yield* Ref.get(location.current)).pathname).toBe("/app/t1/posts/1");
        expect(textAt(root, "#post-param")).toBe("1");
        expect(policy.closed).toHaveLength(2);

        yield* setMode("post#1", "leave");
        expect(pathOf(yield* router.push("/app/t1/posts/2"))).toBe("Committed /app/t1/posts/2");
        yield* readyPost(page, "t1", "2");
      }),
  );

  it.scoped.layer(frameLayer("leave-noop"))(
    "12. a request that would not move leaves an open prompt alone",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        // The route's own navigation, as the router hands it to `enter`.
        const app = makeApp();
        let navigation = Option.none<Route.RouteNavigation>();
        const capturing: typeof app = {
          ...app,
          enter: (url, given) => {
            navigation = Option.fromNullishOr(given);
            return app.enter(url, given);
          },
        };
        const { page, router, location } = yield* mountApp(capturing, root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "dialog");
        const routeNavigation = Option.getOrThrow(navigation);
        const moving = yield* Effect.forkChild(router.push("/app/t1/posts/2"));
        const prompt = yield* Queue.take(policy.prompts);

        // A url-state write that changes nothing, a same-URL request, and a
        // stale instance's request: none of them is a newer intent.
        const unchanged = yield* Effect.forkChild(router.replace((current) => current.href));
        const same = yield* Effect.forkChild(router.push("/app/t1/posts/1"));
        const stale = yield* Effect.forkChild(
          routeNavigation.push("/app/t1/posts/9", { _tag: "RouteInstance" }),
        );
        yield* Effect.yieldNow;
        expect(policy.closed).toEqual([]);
        expect(hasAt(document.body, `#dialog-${String(prompt.question)}`)).toBe(true);

        yield* Deferred.succeed(prompt.answer, Leave.Stay);
        expect(pathOf(yield* Fiber.join(moving))).toBe("Stayed /app/t1/posts/1");
        expect(pathOf(yield* Fiber.join(unchanged))).toBe("Unchanged /app/t1/posts/1");
        expect(pathOf(yield* Fiber.join(same))).toBe("Unchanged /app/t1/posts/1");
        expect(pathOf(yield* Fiber.join(stale))).toBe("Unchanged /app/t1/posts/1");
        expect(policy.asked).toHaveLength(1);
        expect(location.history).toEqual([]);
      }),
  );

  it.scoped.layer(frameLayer("leave-consumer"))(
    "13. one router consumes a Location's traversals; a closed one holds nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const other = yield* makeRoot;
        const { page, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");

        // A second router on the same Location is a defect.
        const second = yield* Effect.exit(
          ViewTest.make({
            host: Dom.host,
            root: other,
            setup: (host, mountRoot) =>
              mountRouter({
                landing: NavigationBehavior.Restore,
                traversalReadLimit: "3 seconds",
                routes: [makeApp()],
                notFound: NotFound,
                host,
                root: mountRoot,
              }).pipe(Effect.provideService(Location, location.service)),
          }),
        );
        const defect = Exit.match(second, {
          onSuccess: () => "mounted",
          onFailure: (cause) => Result.getOrElse(Cause.findDefect(cause), () => "no defect"),
        });
        expect(
          yield* Effect.orDie(Schema.decodeUnknownEffect(Traversal.TraversalConsumerTaken)(defect)),
        ).toMatchObject({ _tag: "TraversalConsumerTaken" });
        expect(location.traversals.active()).toBe(true);

        // The mount closes before its Location: nothing may wait for it.
        yield* page.close;
        expect(location.traversals.active()).toBe(false);
        const late = yield* makeTraversal(location, "/app/t1/posts/2", "precommit");
        yield* location.traversals.offer(late.traversal);
        expect(Option.isSome(yield* Deferred.poll(late.finished))).toBe(true);
        expect(yield* Deferred.await(late.answered)).toBe(true);
      }),
  );

  it.scoped.layer(frameLayer("leave-traversal-push"))(
    "14. a push supersedes a traversal prompt, and the traversal is refused",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "dialog");
        const back = yield* makeTraversal(location, "/app/t1/posts/2", "precommit");
        yield* location.traversals.offer(back.traversal);
        const first = yield* Queue.take(policy.prompts);

        const pushing = yield* Effect.forkChild(router.push("/app/t1/posts/3"));
        expect(yield* Deferred.await(back.answered)).toBe(false);
        yield* Deferred.await(back.finished);
        const second = yield* Queue.take(policy.prompts);
        expect(policy.closed).toEqual([`post#1#${String(first.question)}`]);

        yield* Deferred.succeed(second.answer, Leave.Leave);
        expect(pathOf(yield* Fiber.join(pushing))).toBe("Committed /app/t1/posts/3");
        yield* readyPost(page, "t1", "3");
        expect(location.history).toEqual(["push /app/t1/posts/3"]);
      }),
  );

  it.scoped.layer(frameLayer("leave-pop-push"))(
    "15. a pop supersedes a push prompt, and the router follows the pop",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location, logs } = yield* mountApp(
          makeApp(),
          root,
          "/app/t1/posts/1",
        );
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "dialog");
        const pushing = yield* Effect.forkChild(router.push("/app/t1/posts/2"));
        const prompt = yield* Queue.take(policy.prompts);

        yield* Ref.set(location.current, new URL(`${origin}/app/t1/posts/5`));
        yield* Queue.offer(location.pops, new URL(`${origin}/app/t1/posts/5`));
        expect(pathOf(yield* Fiber.join(pushing))).toBe("Unchanged /app/t1/posts/1");
        expect(policy.closed).toEqual([`post#1#${String(prompt.question)}`]);
        yield* readyPost(page, "t1", "5");
        expect(location.history).toEqual([]);
        expect(logs).toEqual([
          `Warn route.leave.unprotected url=${origin}/app/t1/posts/5 kind=pop checks=1 reason=committed`,
        ]);
      }),
  );

  it.scoped.layer(frameLayer("leave-abandoned"))(
    "16. a traversal the platform abandons during its prompt decides nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "dialog");
        const back = yield* makeTraversal(location, "/app/t1/posts/2", "precommit");
        yield* location.traversals.offer(back.traversal);
        const prompt = yield* Queue.take(policy.prompts);

        yield* Deferred.succeed(back.abandon, void 0);
        expect(yield* Deferred.await(back.answered)).toBe(false);
        yield* Deferred.await(back.finished);
        expect(policy.closed).toEqual([`post#1#${String(prompt.question)}`]);
        expect(hasAt(document.body, "dialog")).toBe(false);

        yield* Deferred.succeed(prompt.answer, Leave.Leave);
        expect(location.history).toEqual([]);
        expect(textAt(root, "#post-param")).toBe("1");
      }),
  );

  it.scoped.layer(frameLayer("leave-close-traversal"))(
    "17. a root close during a traversal prompt lets the traversal through; a closed router admits nothing",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const policy = yield* Policy;
        const { page, router, location } = yield* mountApp(makeApp(), root, "/app/t1/posts/1");
        yield* readyPost(page, "t1", "1");
        yield* setMode("post#1", "dialog");
        const back = yield* makeTraversal(location, "/app/t1/posts/2", "precommit");
        yield* location.traversals.offer(back.traversal);
        const prompt = yield* Queue.take(policy.prompts);

        yield* page.close;
        // Cleanup, not a refusal: the platform is let through.
        expect(yield* Deferred.await(back.answered)).toBe(true);
        yield* Deferred.await(back.finished);
        expect(policy.closed).toEqual([`post#1#${String(prompt.question)}`]);
        expect(policy.asked).toHaveLength(1);

        // The closed router's admission refuses a command: it reaches no
        // result, so it is interrupted, and history stays.
        const after = yield* Effect.exit(router.push("/app/t1/posts/3"));
        expect(Exit.hasInterrupts(after)).toBe(true);
        expect(location.history).toEqual(["traverse /app/t1/posts/2"]);
      }),
  );

  it.scoped.layer(frameLayer("leave-owner"))(
    "10. a registration for another segment than the mounted one is a defect",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const wrong = Route.client(
          "wrong",
          LeaveBranch.leaf(tenantSegment, () =>
            Effect.as(
              Leave.onLeave(postSegment, () => Effect.succeed(Leave.Leave)),
              <p>wrong</p>,
            ),
          ),
        );
        const exit = yield* Effect.exit(mountApp(wrong, root, "/app/t1"));
        const defect = Exit.match(exit, {
          onSuccess: () => "mounted",
          onFailure: (cause) => Result.getOrElse(Cause.findDefect(cause), () => "no defect"),
        });
        const mismatch = yield* Effect.orDie(
          Schema.decodeUnknownEffect(Leave.LeaveOwnerMismatch)(defect),
        );
        expect(mismatch).toMatchObject({
          owner: "post",
          mounted: "tenant",
        });
      }),
  );
});
