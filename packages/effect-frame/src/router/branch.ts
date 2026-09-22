import type {
  AnyContract,
  AnyQuery,
  ArgsOf,
  FollowedQuery,
  KeyOf,
  QueryCacheService,
  QueryEntry,
  QueryFailure,
  QueryState,
  RemoteActorRef,
  ResultOf,
  Source,
  TransportReadError,
  TransportService,
} from "effect-frame/actor";
import {
  ActorTransport,
  QueryCache,
  Ready,
  canonicalize,
  keyOf,
  ref,
} from "effect-frame/actor/client";
import type { Node } from "effect-frame/view";
import { View } from "effect-frame/view";
import {
  Effect,
  Exit,
  Function,
  Option,
  Result,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { attempt } from "../view/attempt.js";
import type {
  AnyRoute,
  Entered,
  ParamsCodec,
  Part,
  PathRecord,
  SearchCodec,
  SearchRecord,
} from "./route.js";
import {
  matchPrefix,
  parseTemplate,
  pathSegments,
  printSearch,
  readSearch,
  search as searchCodec,
} from "./route.js";
import { register as registerInspection } from "./route-inspection.js";

/**
 * PRIVATE proof (route slice 2, the #36 dependency). This module is not
 * exported from `effect-frame/router`. It proves the nested transition
 * against the real router, view runtime, actor transport, and query cache
 * before any public nested-route constructor is chosen.
 * See `docs/design/nested-transition.md`.
 *
 * A tree of segments mounts as one `AnyRoute`. The existing router keeps
 * history, the same-URL no-op, stale-instance rejection, and not-found; it
 * calls `update` for every URL the tree matches, and `update` runs the
 * branch diff below.
 *
 * - A layout yields its outlet: a delayed Effect that it places inside its
 *   own children, for example inside `Loading`. The outlet is a keyed
 *   `View.list` of at most one child instance.
 * - A segment instance owns one Scope. Its bindings, its view, and its
 *   descendants are children of that Scope, forked in that order, so a close
 *   runs descendants, then the view, then the bindings.
 * - Declaration interests are owned by the transition, not by a view. Each
 *   one lives in its own Scope under the tree's declaration root. A
 *   transition acquires every new interest of the target branch, in
 *   parallel, before it publishes a value, replaces an outlet item, or
 *   releases an interest. It releases a replaced or exited interest only
 *   after the exited view has closed.
 * - A query binding is shaped as `FollowedQuery`. An actor binding is a
 *   `Source` of the current real `RemoteActorRef`. A moved binding holds a
 *   new ref; an old ref keeps its old address.
 */

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** One query entry a segment needs, as data. */
export interface QueryDeclaration<Q extends AnyQuery> {
  readonly _tag: "QueryDeclaration";
  readonly contract: Q;
  readonly args: ArgsOf<Q>;
}

/** One actor address a segment needs, as data. */
export interface ActorDeclaration<C extends AnyContract> {
  readonly _tag: "ActorDeclaration";
  readonly contract: C;
  readonly key: KeyOf<C>;
}

export type Declaration = QueryDeclaration<AnyQuery> | ActorDeclaration<AnyContract>;

/** A segment's declarations by name. */
export type Declarations = Readonly<Record<string, Declaration>>;

/** No declarations. */
export type NoDeclarations = Readonly<Record<never, never>>;

export const query = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>): QueryDeclaration<Q> => ({
  _tag: "QueryDeclaration",
  contract,
  args,
});

export const actor = <C extends AnyContract>(contract: C, key: KeyOf<C>): ActorDeclaration<C> => ({
  _tag: "ActorDeclaration",
  contract,
  key,
});

/** What a view receives for one declaration. */
export type BindingOf<D> =
  D extends QueryDeclaration<infer Q extends AnyQuery>
    ? FollowedQuery<ResultOf<Q>, QueryFailure>
    : D extends ActorDeclaration<infer C extends AnyContract>
      ? Source<RemoteActorRef<C>>
      : never;

/** Every binding a segment's view receives, inherited ones included. */
export type RouteData<Data extends Declarations> = {
  readonly [K in keyof Data]: BindingOf<Data[K]>;
};

/** The services a transition needs to acquire one declaration. */
export type ServicesOf<D> =
  D extends QueryDeclaration<AnyQuery>
    ? QueryCache | ActorTransport
    : D extends ActorDeclaration<AnyContract>
      ? ActorTransport
      : never;

/** An own declaration may not reuse a name its ancestors declared. */
export type Disjoint<Inherited> = { readonly [K in keyof Inherited]?: never };

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/** The decoded values one segment observes. */
export interface Values<Params, Search> {
  readonly params: Params;
  readonly search: Search;
}

/** The part of a segment every holder can read without its types. */
export interface AnySegment {
  readonly _tag: "Segment";
  readonly name: string;
  readonly parent: Option.Option<AnySegment>;
  readonly parts: ReadonlyArray<Part>;
}

/**
 * A segment descriptor: address, codecs, and data. It has no view, so a
 * child can name its parent and inherit its data type before any view
 * exists. `Data` is every declaration the view sees, inherited first.
 */
export interface Segment<
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
> extends AnySegment {
  readonly name: Name;
  /** Decode the accumulated path record and the URL search. None is a non-match. */
  decode(record: PathRecord, search: SearchRecord): Option.Option<Values<Params, Search>>;
  /** The encoded form, used to decide whether a stayed segment changed. */
  signature(record: PathRecord, values: Values<Params, Search>): string;
  /** This segment's own declarations. Inherited ones are the parent's. */
  declare(values: Values<Params, Search>): Own;
  /** Phantom: the declarations the view sees. */
  readonly "~data": (_: never) => Data;
}

export interface SegmentOptions<P extends ParamsCodec, S extends SearchCodec, Own> {
  /** A template relative to the parent. The URLPattern grammar that prints. */
  readonly path: string;
  /** Decodes the path record accumulated from the root to this segment. */
  readonly params: P;
  readonly search?: S;
  readonly data?: (values: Values<P["Type"], S["Type"]>) => Own;
}

const NoSearch = searchCodec(Schema.Struct({}));
type NoSearch = typeof NoSearch;

const phantom =
  <A>() =>
  (value: never): A =>
    value;

const noDeclarations = (): NoDeclarations => ({});

/** A stable printed form of a path record, used only to compare two matches. */
const recordSignature = (record: PathRecord): string =>
  Object.keys(record)
    .toSorted()
    .map((key) => {
      const value = Option.getOrElse(Option.fromNullishOr(record[key]), () => "");
      return `${encodeURIComponent(key)}=${[value].flat().map(encodeURIComponent).join("/")}`;
    })
    .join("&");

const makeSegment = <
  const Name extends string,
  P extends ParamsCodec,
  S extends SearchCodec,
  Own extends Declarations,
  Data extends Declarations,
>(
  name: Name,
  parent: Option.Option<AnySegment>,
  options: SegmentOptions<P, S, Own>,
  data: (values: Values<P["Type"], S["Type"]>) => Own,
): Segment<Name, P["Type"], S["Type"], Own, Data> => {
  const parts = Result.getOrThrowWith(parseTemplate(options.path), (rejected) => rejected);
  const search: SearchCodec = Option.getOrElse(
    Option.fromNullishOr(options.search),
    () => NoSearch,
  );
  const decodeParams = Schema.decodeUnknownOption(options.params);
  const decodeSearch = Schema.decodeUnknownOption(search);
  const encodeSearch = Schema.encodeUnknownSync(search);
  return {
    _tag: "Segment",
    name,
    parent,
    parts,
    decode: (record, searchRecord) =>
      Option.flatMap(decodeParams(record), (params) =>
        Option.flatMap(decodeSearch(searchRecord), (searchValue) =>
          Option.some({ params, search: searchValue }),
        ),
      ),
    signature: (record, values) =>
      `${recordSignature(record)}${printSearch(encodeSearch(values.search))}`,
    declare: data,
    "~data": phantom<Data>(),
  };
};

/** A root segment. */
export const segment = <
  const Name extends string,
  P extends ParamsCodec,
  S extends SearchCodec = NoSearch,
  Own extends Declarations = NoDeclarations,
>(
  name: Name,
  options: SegmentOptions<P, S, Own>,
): Segment<Name, P["Type"], S["Type"], Own, Own> =>
  makeSegment<Name, P, S, Own, Own>(
    name,
    Option.none(),
    options,
    Option.getOrElse(Option.fromNullishOr(options.data), () => (): Own => ownEmpty<Own>()),
  );

/** A segment under a parent. It inherits the parent's declarations. */
export const child = <
  ParentData extends Declarations,
  const Name extends string,
  P extends ParamsCodec,
  S extends SearchCodec = NoSearch,
  Own extends Declarations & Disjoint<ParentData> = NoDeclarations,
>(
  parent: Segment<string, unknown, unknown, Declarations, ParentData>,
  name: Name,
  options: SegmentOptions<P, S, Own>,
): Segment<Name, P["Type"], S["Type"], Own, ParentData & Own> =>
  makeSegment<Name, P, S, Own, ParentData & Own>(
    name,
    Option.some(parent),
    options,
    Option.getOrElse(Option.fromNullishOr(options.data), () => (): Own => ownEmpty<Own>()),
  );

/**
 * A segment without a data function declares nothing. Its `Own` is then the
 * default empty record, so the empty object is exactly that type.
 */
const ownEmpty = <Own>(): Own => {
  const empty: unknown = noDeclarations();
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Own defaults to NoDeclarations when data is absent.
  return empty as Own;
};

// ---------------------------------------------------------------------------
// Views and branches
// ---------------------------------------------------------------------------

/** What a segment's view receives. Sources, so a stayed segment re-runs nothing. */
export interface SegmentProps<Params, Search, Data extends Declarations> {
  readonly params: Source<Params>;
  readonly search: Source<Search>;
  readonly data: RouteData<Data>;
}

/**
 * A layout also receives its outlet: a delayed setup that the layout yields
 * where the child belongs. The child's requirements stay visible in
 * `ChildR`, so yielding it inside `Loading` is what provides `LoadingScope`.
 */
export interface LayoutProps<
  Params,
  Search,
  Data extends Declarations,
  ChildR,
> extends SegmentProps<Params, Search, Data> {
  readonly outlet: Effect.Effect<Node, never, ChildR>;
}

export type PropsOf<Seg> =
  Seg extends Segment<string, infer P, infer S, Declarations, infer Data>
    ? SegmentProps<P, S, Data>
    : never;

export type LayoutPropsOf<Seg, ChildR> =
  Seg extends Segment<string, infer P, infer S, Declarations, infer Data>
    ? LayoutProps<P, S, Data, ChildR>
    : never;

/**
 * A mounted segment. `R` is its view's requirements. It appears only in
 * output positions, so a child branch widens into its layout's union.
 */
interface Instance<R> {
  readonly key: string;
  readonly branch: object;
  /** The view's setup, owned by this instance's view Scope. */
  readonly setup: Effect.Effect<Node, never, R>;
  /** Close descendants, the view, and the bindings, in that order. */
  readonly close: Effect.Effect<void>;
  /** Release this instance's and its descendants' declaration interests. */
  readonly release: Effect.Effect<void>;
  /** The current decoded values, for inspection. */
  readonly values: Effect.Effect<Values<unknown, unknown>>;
  /** The current child instance, for inspection. */
  readonly child: Effect.Effect<Option.Option<Instance<unknown>>>;
}

/** A tree mounted once: the Scope its declarations live under and its services. */
interface Tree {
  readonly declarations: Scope.Scope;
  readonly cache: Option.Option<QueryCacheService>;
  readonly transport: Option.Option<TransportService>;
  readonly nextKey: (name: string) => string;
}

/** Prepared entry of a segment and every matched descendant. Nothing is published yet. */
interface Entering<R> {
  readonly create: (inherited: DataRecord, parentScope: Scope.Scope) => Effect.Effect<Instance<R>>;
  readonly abort: Effect.Effect<void>;
}

/** A prepared move of a stayed instance. `commit` publishes, swaps, then releases. */
interface Staying {
  readonly commit: Effect.Effect<void>;
  readonly abort: Effect.Effect<void>;
}

/** One matched segment and the matched remainder of its branch. */
interface Match<R> {
  readonly branch: object;
  enter(tree: Tree): Effect.Effect<Entering<R>, TransportReadError>;
  stay(instance: Instance<unknown>, tree: Tree): Effect.Effect<Staying, TransportReadError>;
}

interface MatchInput {
  readonly segments: ReadonlyArray<string>;
  readonly index: number;
  readonly record: PathRecord;
  readonly search: SearchRecord;
}

/**
 * A segment with its view and children. `ViewR` is what its view needs,
 * including every child's view requirements that the outlet carries.
 * `DataR` is what its transition needs to acquire declarations.
 */
export interface Branch<Seg extends AnySegment, ViewR, DataR> {
  readonly _tag: "Branch";
  readonly segment: Seg;
  match(input: MatchInput): Option.Option<Match<ViewR>>;
  readonly "~data": (_: never) => DataR;
}

/** Any branch with view requirements `R`. */
export type AnyBranch<R> = Branch<AnySegment, R, unknown>;

type ViewROf<B> = B extends Branch<AnySegment, infer R, unknown> ? R : never;
type DataROf<B> = B extends Branch<AnySegment, unknown, infer R> ? R : never;
type OwnServices<Seg> =
  Seg extends Segment<string, unknown, unknown, infer Own, Declarations>
    ? ServicesOf<Own[keyof Own]>
    : never;

/** A leaf segment: it has no outlet. */
export const leaf = <
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  R,
>(
  seg: Segment<Name, Params, Search, Own, Data>,
  view: (props: SegmentProps<Params, Search, Data>) => Effect.Effect<Node, never, R>,
): Branch<
  Segment<Name, Params, Search, Own, Data>,
  Exclude<R, Scope.Scope>,
  OwnServices<Segment<Name, Params, Search, Own, Data>>
> => makeBranch<Name, Params, Search, Own, Data, R, never>(seg, [], (props) => view(props));

/**
 * A layout: its view receives the outlet. Children are built first so their
 * view requirements reach the outlet's type; each child must name this
 * segment as its parent, so their inherited data type is this one's.
 */
export const layout = <
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  const Children extends ReadonlyArray<AnyBranch<unknown>>,
  R,
>(
  seg: Segment<Name, Params, Search, Own, Data>,
  children: Children,
  view: (
    props: LayoutProps<Params, Search, Data, ViewROf<Children[number]>>,
  ) => Effect.Effect<Node, never, R>,
): Branch<
  Segment<Name, Params, Search, Own, Data>,
  Exclude<R, Scope.Scope>,
  OwnServices<Segment<Name, Params, Search, Own, Data>> | DataROf<Children[number]>
> => {
  for (const branch of children) {
    if (!Option.contains(branch.segment.parent, seg)) {
      return Option.getOrThrowWith(Option.none(), () =>
        BranchRejected.make({
          segment: branch.segment.name,
          reason: `a child of ${seg.name} must name it as its parent`,
        }),
      );
    }
  }
  if (seg.parts.some((part) => part._tag === "Tail")) {
    return Option.getOrThrowWith(Option.none(), () =>
      BranchRejected.make({ segment: seg.name, reason: "a layout cannot end in a tail" }),
    );
  }
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- the children tuple is exactly ViewROf<Children[number]>'s branches.
  const typed = children as ReadonlyArray<AnyBranch<ViewROf<Children[number]>>>;
  return makeBranch<Name, Params, Search, Own, Data, R, ViewROf<Children[number]>>(
    seg,
    typed,
    (props, outlet) => view({ ...props, outlet }),
  );
};

/** A branch the builder cannot mount. */
export class BranchRejected extends Schema.TaggedError<BranchRejected>()("BranchRejected", {
  segment: Schema.String,
  reason: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/** Every exposed binding by name, inherited first. A view sees it as `RouteData`. */
type DataRecord = ReadonlyMap<string, unknown>;

type Resource =
  | { readonly _tag: "Query"; readonly entry: QueryEntry<unknown, QueryFailure> }
  | { readonly _tag: "Actor"; readonly ref: RemoteActorRef<AnyContract> };

/** One declaration interest the transition holds. */
interface Acquired {
  readonly key: string;
  readonly scope: Scope.Closeable;
  readonly resource: Resource;
}

/** One declaration name of one instance. */
interface Binding {
  readonly current: () => Acquired;
  readonly exposed: unknown;
  /** Point the binding at a new interest. Returns the one it replaced. */
  readonly install: (next: Acquired) => Effect.Effect<Acquired>;
}

const declarationKey = (declaration: Declaration): Effect.Effect<string> => {
  if (declaration._tag === "QueryDeclaration") {
    return Effect.map(
      Effect.orDie(Schema.encodeUnknownEffect(declaration.contract.args)(declaration.args)),
      (encoded) =>
        `query:${keyOf({
          query: declaration.contract.name,
          version: declaration.contract.version,
          args: canonicalize(encoded),
        })}`,
    );
  }
  return Effect.map(
    Effect.orDie(Schema.encodeUnknownEffect(declaration.contract.key)(declaration.key)),
    (encoded) =>
      `actor:${declaration.contract.name}@${String(declaration.contract.version)}/${canonicalize(encoded)}`,
  );
};

const missing = (service: string) =>
  Effect.die(`declared route data needs ${service} where the tree is mounted`);

const open = (
  tree: Tree,
  declaration: Declaration,
): Effect.Effect<Resource, TransportReadError, Scope.Scope> =>
  Option.match(tree.transport, {
    onNone: () => missing("ActorTransport"),
    onSome: (transport) => {
      if (declaration._tag === "QueryDeclaration") {
        return Option.match(tree.cache, {
          onNone: () => missing("QueryCache"),
          onSome: (cache) =>
            Effect.map(
              cache
                .open(declaration.contract, declaration.args)
                .pipe(Effect.provideService(ActorTransport, transport)),
              (entry): Resource => ({ _tag: "Query", entry }),
            ),
        });
      }
      return Effect.map(
        ref(declaration.contract, declaration.key).pipe(
          Effect.provideService(ActorTransport, transport),
        ),
        (opened): Resource => ({ _tag: "Actor", ref: opened }),
      );
    },
  });

/**
 * Acquire one interest in a fresh Scope under the declaration root. A
 * failure closes that Scope before it is reported.
 */
const acquire = (
  tree: Tree,
  key: string,
  declaration: Declaration,
): Effect.Effect<Acquired, TransportReadError> =>
  Effect.flatMap(Scope.fork(tree.declarations), (scope) =>
    Scope.provide(open(tree, declaration), scope).pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit)) {
          return Scope.close(scope, exit);
        }
        return Effect.void;
      }),
      Effect.map((resource): Acquired => ({ key, scope, resource })),
    ),
  );

const releaseAll = (acquired: ReadonlyArray<Acquired>): Effect.Effect<void> =>
  Effect.forEach(acquired, (one) => Scope.close(one.scope, Exit.void), { discard: true });

/**
 * Run prepared work in parallel. Either every part succeeds, or every part
 * that succeeded is aborted and the first failure is reported.
 */
const allOrNothing = <A, E>(
  parts: ReadonlyArray<Effect.Effect<A, E>>,
  abort: (done: A) => Effect.Effect<void>,
): Effect.Effect<ReadonlyArray<A>, E> =>
  Effect.gen(function* () {
    const exits = yield* Effect.forEach(parts, (part) => Effect.exit(part), {
      concurrency: Math.max(parts.length, 1),
    });
    const done = exits.flatMap(successes);
    const failure = Option.fromNullishOr(exits.find(Exit.isFailure));
    if (Option.isNone(failure)) {
      return done;
    }
    yield* Effect.forEach(done, abort, { discard: true });
    return yield* Effect.failCause(failure.value.cause);
  });

const successes = <A, E>(exit: Exit.Exit<A, E>): ReadonlyArray<A> => {
  if (Exit.isSuccess(exit)) {
    return [exit.value];
  }
  return [];
};

/** While the next key loads, the last value stays on screen marked stale. */
const carry = <A, E>(shown: QueryState<A, E>, incoming: QueryState<A, E>): QueryState<A, E> => {
  if (incoming._tag === "Loading" && shown._tag === "Ready") {
    return Ready(shown.value, true);
  }
  return incoming;
};

const queryOf = (acquired: Acquired): Effect.Effect<QueryEntry<unknown, QueryFailure>> => {
  if (acquired.resource._tag === "Query") {
    return Effect.succeed(acquired.resource.entry);
  }
  return Effect.die(`declaration ${acquired.key} changed from a query to an actor`);
};

const actorOf = (acquired: Acquired): Effect.Effect<RemoteActorRef<AnyContract>> => {
  if (acquired.resource._tag === "Actor") {
    return Effect.succeed(acquired.resource.ref);
  }
  return Effect.die(`declaration ${acquired.key} changed from an actor to a query`);
};

/**
 * A query binding: one `FollowedQuery` whose entry the transition moves.
 * The follower lives in its own Scope under the instance's bindings Scope;
 * the interest itself stays with the transition.
 */
const queryBinding = Effect.fn("Branch.queryBinding")(function* (
  first: Acquired,
  owner: Scope.Scope,
) {
  const entry = yield* queryOf(first);
  const output = yield* SubscriptionRef.make(yield* entry.state.get);
  let current = first;
  let currentEntry = entry;
  let follow = yield* Scope.fork(owner);
  const followEntry = (next: QueryEntry<unknown, QueryFailure>, scope: Scope.Scope) =>
    Effect.forkIn(
      Stream.runForEach(next.state.changes, (state) =>
        SubscriptionRef.update(output, (shown) => carry(shown, state)),
      ),
      scope,
    );
  yield* followEntry(entry, follow);
  const exposed: FollowedQuery<unknown, QueryFailure> = {
    state: { get: SubscriptionRef.get(output), changes: SubscriptionRef.changes(output) },
    refresh: Effect.suspend(() => currentEntry.refresh),
  };
  const binding: Binding = {
    current: () => current,
    exposed,
    install: (next) =>
      Effect.gen(function* () {
        const nextEntry = yield* queryOf(next);
        yield* Scope.close(follow, Exit.void);
        follow = yield* Scope.fork(owner);
        const state = yield* nextEntry.state.get;
        yield* SubscriptionRef.update(output, (shown) => carry(shown, state));
        yield* followEntry(nextEntry, follow);
        const replaced = current;
        current = next;
        currentEntry = nextEntry;
        return replaced;
      }),
  };
  return binding;
});

/** An actor binding: the ref lives in the instance state beside its params. */
const actorBinding = (
  name: string,
  first: Acquired,
  state: Source<InstanceState<unknown, unknown>>,
): Binding => {
  let current = first;
  const exposed: Source<RemoteActorRef<AnyContract>> = {
    get: Effect.flatMap(state.get, (value) => refIn(value, name)),
    changes: Stream.mapEffect(state.changes, (value) => refIn(value, name)),
  };
  return {
    current: () => current,
    exposed,
    install: (next) =>
      Effect.sync(() => {
        const replaced = current;
        current = next;
        return replaced;
      }),
  };
};

/** Values and actor refs, published together so a control sees a consistent pair. */
interface InstanceState<Params, Search> {
  readonly values: Values<Params, Search>;
  readonly refs: ReadonlyMap<string, RemoteActorRef<AnyContract>>;
}

const refIn = (
  state: InstanceState<unknown, unknown>,
  name: string,
): Effect.Effect<RemoteActorRef<AnyContract>> =>
  Option.match(Option.fromNullishOr(state.refs.get(name)), {
    onNone: () => Effect.die(`actor binding ${name} has no ref`),
    onSome: Effect.succeed,
  });

const refsOf = (
  bindings: ReadonlyMap<string, Binding>,
): Effect.Effect<ReadonlyMap<string, RemoteActorRef<AnyContract>>> =>
  Effect.map(
    Effect.forEach(
      Array.from(bindings).filter(([, binding]) => binding.current().resource._tag === "Actor"),
      ([name, binding]) =>
        Effect.map(
          actorOf(binding.current()),
          (opened): readonly [string, RemoteActorRef<AnyContract>] => [name, opened],
        ),
    ),
    (entries) => new Map(entries),
  );

// ---------------------------------------------------------------------------
// The branch runtime
// ---------------------------------------------------------------------------

interface Internals<Params, Search, ChildR> {
  readonly state: SubscriptionRef.SubscriptionRef<InstanceState<Params, Search>>;
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly data: DataRecord;
  readonly childrenScope: Scope.Scope;
  readonly outlet: SubscriptionRef.SubscriptionRef<ReadonlyArray<Instance<ChildR>>>;
  signature: string;
  child: Option.Option<Instance<ChildR>>;
}

type ChildPlan<ChildR> =
  | { readonly _tag: "Stay"; readonly staying: Staying }
  | { readonly _tag: "Enter"; readonly entering: Entering<ChildR> }
  | { readonly _tag: "None" };

/** Own declarations with their keys, in a stable name order. */
const keyed = (declarations: Declarations) =>
  Effect.forEach(Object.entries(declarations), ([name, declaration]) =>
    Effect.map(declarationKey(declaration), (key) => ({ name, key, declaration })),
  );

const assemble = (inherited: DataRecord, own: ReadonlyMap<string, Binding>): DataRecord => {
  const record = new Map(inherited);
  for (const [name, binding] of own) {
    if (record.has(name)) {
      return Option.getOrThrowWith(Option.none(), () =>
        BranchRejected.make({ segment: name, reason: "a declaration name is inherited already" }),
      );
    }
    record.set(name, binding.exposed);
  }
  return record;
};

/** The record a view receives. One field per binding name. */
const routeData = <Data extends Declarations>(data: DataRecord): RouteData<Data> => {
  const fields: unknown = Object.fromEntries(data);
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- assemble builds exactly one binding per declared name, inherited first.
  return fields as RouteData<Data>;
};

const makeBranch = <
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  R,
  ChildR,
>(
  seg: Segment<Name, Params, Search, Own, Data>,
  children: ReadonlyArray<AnyBranch<ChildR>>,
  view: (
    props: SegmentProps<Params, Search, Data>,
    outlet: Effect.Effect<Node, never, ChildR>,
  ) => Effect.Effect<Node, never, R>,
): Branch<Segment<Name, Params, Search, Own, Data>, Exclude<R, Scope.Scope>, never> => {
  // Typed memory of the instances this branch created. A match of this
  // branch reads it back, so no instance value is ever cast.
  const created = new WeakMap<Instance<unknown>, Internals<Params, Search, ChildR>>();
  const identity = {};

  const matchChild = (input: MatchInput): Option.Option<Match<ChildR>> => {
    for (const branch of children) {
      const matched = branch.match(input);
      if (Option.isSome(matched)) {
        return matched;
      }
    }
    return Option.none();
  };

  const create = Effect.fn("Branch.create")(function* (
    tree: Tree,
    values: Values<Params, Search>,
    signature: string,
    acquired: ReadonlyArray<{ readonly name: string; readonly acquired: Acquired }>,
    childEntering: Option.Option<Entering<ChildR>>,
    inherited: DataRecord,
    parentScope: Scope.Scope,
  ) {
    const scope = yield* Scope.fork(parentScope);
    const bindingsScope = yield* Scope.fork(scope);
    const viewScope = yield* Scope.fork(scope);
    const childrenScope = yield* Scope.fork(scope);
    const state = yield* SubscriptionRef.make<InstanceState<Params, Search>>({
      values,
      refs: new Map(),
    });
    const stateSource: Source<InstanceState<Params, Search>> = {
      get: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
    };
    const bindings = new Map<string, Binding>();
    for (const one of acquired) {
      if (one.acquired.resource._tag === "Query") {
        bindings.set(one.name, yield* queryBinding(one.acquired, bindingsScope));
      } else {
        bindings.set(one.name, actorBinding(one.name, one.acquired, stateSource));
      }
    }
    yield* SubscriptionRef.set(state, { values, refs: yield* refsOf(bindings) });
    const data = assemble(inherited, bindings);
    const childInstance = yield* Option.match(childEntering, {
      onNone: () => Effect.succeed(Option.none<Instance<ChildR>>()),
      onSome: (entering) => Effect.map(entering.create(data, childrenScope), Option.some),
    });
    const outlet = yield* SubscriptionRef.make<ReadonlyArray<Instance<ChildR>>>(
      Option.toArray(childInstance),
    );
    const internals: Internals<Params, Search, ChildR> = {
      state,
      bindings,
      data,
      childrenScope,
      outlet,
      signature,
      child: childInstance,
    };
    const props: SegmentProps<Params, Search, Data> = {
      params: {
        get: Effect.map(stateSource.get, (current) => current.values.params),
        changes: Stream.map(stateSource.changes, (current) => current.values.params),
      },
      search: {
        get: Effect.map(stateSource.get, (current) => current.values.search),
        changes: Stream.map(stateSource.changes, (current) => current.values.search),
      },
      data: routeData<Data>(data),
    };
    const outletSetup = View.list({
      each: { get: SubscriptionRef.get(outlet), changes: SubscriptionRef.changes(outlet) },
      keyBy: (instance) => instance.key,
      row: (item) => Effect.flatMap(item.get, (instance) => instance.setup),
    });
    const release: Effect.Effect<void> = Effect.suspend(() =>
      Effect.andThen(
        Option.match(internals.child, {
          onNone: () => Effect.void,
          onSome: (current) => current.release,
        }),
        releaseAll(Array.from(internals.bindings.values(), (binding) => binding.current())),
      ),
    );
    const instance: Instance<Exclude<R, Scope.Scope>> = {
      key: tree.nextKey(seg.name),
      branch: identity,
      // The view runs under an owned attempt in the instance's view Scope:
      // a row that starts after the instance closed never runs it.
      setup: Scope.provide(
        attempt(
          Effect.suspend(() => view(props, outletSetup)),
          (error: never): Effect.Effect<Node> => Function.absurd(error),
        ),
        viewScope,
      ),
      close: Scope.close(scope, Exit.void),
      release,
      values: Effect.map(SubscriptionRef.get(state), (current) => current.values),
      child: Effect.sync(() => internals.child),
    };
    created.set(instance, internals);
    return instance;
  });

  const prepareChild = (
    tree: Tree,
    input: Option.Option<Match<ChildR>>,
    current: Option.Option<Instance<ChildR>>,
  ): Effect.Effect<ChildPlan<ChildR>, TransportReadError> =>
    Option.match(input, {
      onNone: () => Effect.succeed<ChildPlan<ChildR>>({ _tag: "None" }),
      onSome: (matched) => {
        if (Option.isSome(current) && current.value.branch === matched.branch) {
          return Effect.map(matched.stay(current.value, tree), (staying): ChildPlan<ChildR> => ({
            _tag: "Stay",
            staying,
          }));
        }
        return Effect.map(matched.enter(tree), (entering): ChildPlan<ChildR> => ({
          _tag: "Enter",
          entering,
        }));
      },
    });

  const abortChild = (plan: ChildPlan<ChildR>): Effect.Effect<void> => {
    if (plan._tag === "Stay") {
      return plan.staying.abort;
    }
    if (plan._tag === "Enter") {
      return plan.entering.abort;
    }
    return Effect.void;
  };

  /** Commit the child plan: stay in place, or swap the outlet item, then exit the old one. */
  const commitChild = Effect.fn("Branch.commitChild")(function* (
    internals: Internals<Params, Search, ChildR>,
    plan: ChildPlan<ChildR>,
  ) {
    if (plan._tag === "Stay") {
      return yield* plan.staying.commit;
    }
    const exited = internals.child;
    let next = Option.none<Instance<ChildR>>();
    if (plan._tag === "Enter") {
      next = Option.some(yield* plan.entering.create(internals.data, internals.childrenScope));
    }
    internals.child = next;
    yield* SubscriptionRef.set(internals.outlet, Option.toArray(next));
    if (Option.isSome(exited)) {
      // The exited view closes first. Its interests are released after it.
      yield* exited.value.close;
      yield* exited.value.release;
    }
  });

  const stayWith = Effect.fn("Branch.stay")(function* (
    tree: Tree,
    internals: Internals<Params, Search, ChildR>,
    values: Values<Params, Search>,
    signature: string,
    childMatch: Option.Option<Match<ChildR>>,
  ) {
    const own = yield* keyed(seg.declare(values));
    const names = new Set(own.map((one) => one.name));
    if (
      names.size !== internals.bindings.size ||
      own.some((one) => !internals.bindings.has(one.name))
    ) {
      return yield* Effect.die(`segment ${seg.name} changed its declaration names`);
    }
    const moves = own.filter((one) =>
      Option.exists(
        Option.fromNullishOr(internals.bindings.get(one.name)),
        (binding) => binding.current().key !== one.key,
      ),
    );
    type Prepared =
      | { readonly _tag: "Own"; readonly name: string; readonly acquired: Acquired }
      | { readonly _tag: "Child"; readonly plan: ChildPlan<ChildR> };
    const parts = yield* allOrNothing<Prepared, TransportReadError>(
      [
        ...moves.map((one) =>
          Effect.map(acquire(tree, one.key, one.declaration), (acquired): Prepared => ({
            _tag: "Own",
            name: one.name,
            acquired,
          })),
        ),
        Effect.map(prepareChild(tree, childMatch, internals.child), (plan): Prepared => ({
          _tag: "Child",
          plan,
        })),
      ],
      (part) => {
        if (part._tag === "Own") {
          return Scope.close(part.acquired.scope, Exit.void);
        }
        return abortChild(part.plan);
      },
    );
    const acquired = parts.filter(
      (part): part is Extract<Prepared, { readonly _tag: "Own" }> => part._tag === "Own",
    );
    const childPlan = Option.getOrElse(
      Option.map(
        Option.fromNullishOr(
          parts.find(
            (part): part is Extract<Prepared, { readonly _tag: "Child" }> => part._tag === "Child",
          ),
        ),
        (part) => part.plan,
      ),
      (): ChildPlan<ChildR> => ({ _tag: "None" }),
    );
    const staying: Staying = {
      abort: Effect.andThen(
        releaseAll(acquired.map((part) => part.acquired)),
        abortChild(childPlan),
      ),
      commit: Effect.gen(function* () {
        const replaced: Array<Acquired> = [];
        for (const part of acquired) {
          const binding = Option.fromNullishOr(internals.bindings.get(part.name));
          if (Option.isSome(binding)) {
            replaced.push(yield* binding.value.install(part.acquired));
          }
        }
        if (acquired.length > 0 || signature !== internals.signature) {
          internals.signature = signature;
          yield* SubscriptionRef.set(internals.state, {
            values,
            refs: yield* refsOf(internals.bindings),
          });
        }
        yield* commitChild(internals, childPlan);
        yield* releaseAll(replaced);
      }),
    };
    return staying;
  });

  const enterWith = Effect.fn("Branch.enter")(function* (
    tree: Tree,
    values: Values<Params, Search>,
    signature: string,
    childMatch: Option.Option<Match<ChildR>>,
  ) {
    const own = yield* keyed(seg.declare(values));
    type Prepared =
      | { readonly _tag: "Own"; readonly name: string; readonly acquired: Acquired }
      | { readonly _tag: "Child"; readonly entering: Entering<ChildR> };
    const childPart: ReadonlyArray<Effect.Effect<Prepared, TransportReadError>> = Option.match(
      childMatch,
      {
        onNone: () => [],
        onSome: (matched) => [
          Effect.map(matched.enter(tree), (entering): Prepared => ({ _tag: "Child", entering })),
        ],
      },
    );
    const parts = yield* allOrNothing<Prepared, TransportReadError>(
      [
        ...own.map((one) =>
          Effect.map(acquire(tree, one.key, one.declaration), (acquired): Prepared => ({
            _tag: "Own",
            name: one.name,
            acquired,
          })),
        ),
        ...childPart,
      ],
      (part) => {
        if (part._tag === "Own") {
          return Scope.close(part.acquired.scope, Exit.void);
        }
        return part.entering.abort;
      },
    );
    const acquired = parts.filter(
      (part): part is Extract<Prepared, { readonly _tag: "Own" }> => part._tag === "Own",
    );
    const childEntering = Option.map(
      Option.fromNullishOr(
        parts.find(
          (part): part is Extract<Prepared, { readonly _tag: "Child" }> => part._tag === "Child",
        ),
      ),
      (part) => part.entering,
    );
    const entering: Entering<Exclude<R, Scope.Scope>> = {
      abort: Effect.andThen(
        releaseAll(acquired.map((part) => part.acquired)),
        Option.match(childEntering, {
          onNone: () => Effect.void,
          onSome: (next) => next.abort,
        }),
      ),
      create: (inherited, parentScope) =>
        create(tree, values, signature, acquired, childEntering, inherited, parentScope),
    };
    return entering;
  });

  const lookup = (instance: Instance<unknown>) =>
    Option.match(Option.fromNullishOr(created.get(instance)), {
      onNone: () => Effect.die(`segment ${seg.name} did not create this instance`),
      onSome: (internals) => Effect.succeed(internals),
    });

  const match = (input: MatchInput): Option.Option<Match<Exclude<R, Scope.Scope>>> =>
    Option.flatMap(matchPrefix(seg.parts, input.segments, input.index), (prefix) => {
      const record: PathRecord = { ...input.record, ...prefix.record };
      return Option.flatMap(seg.decode(record, input.search), (values) => {
        const signature = seg.signature(record, values);
        const childMatch = matchChild({
          segments: input.segments,
          index: prefix.next,
          record,
          search: input.search,
        });
        if (Option.isNone(childMatch) && prefix.next !== input.segments.length) {
          return Option.none();
        }
        const matched: Match<Exclude<R, Scope.Scope>> = {
          branch: identity,
          enter: (tree) => enterWith(tree, values, signature, childMatch),
          stay: (instance, tree) =>
            Effect.flatMap(lookup(instance), (internals) =>
              stayWith(tree, internals, values, signature, childMatch),
            ),
        };
        return Option.some(matched);
      });
    });

  return {
    _tag: "Branch",
    segment: seg,
    match,
    "~data": phantom<never>(),
  };
};

// ---------------------------------------------------------------------------
// The tree as one route
// ---------------------------------------------------------------------------

interface MountedTree<R> {
  readonly tree: Tree;
  readonly root: Instance<R>;
}

const matchUrl = <R>(root: AnyBranch<R>, url: URL): Option.Option<Match<R>> =>
  root.match({
    segments: pathSegments(url.pathname),
    index: 0,
    record: {},
    search: readSearch(url.searchParams),
  });

/** The deepest instance's values, for the router's inspection record. */
const deepest = (instance: Instance<unknown>): Effect.Effect<Values<unknown, unknown>> =>
  Effect.flatMap(instance.child, (next) =>
    Option.match(next, {
      onNone: () => instance.values,
      onSome: deepest,
    }),
  );

/**
 * Mount a tree as one route. `update` runs the nested transition for every
 * URL the tree matches. An acquisition failure is a defect in this slice:
 * nothing is published, and the typed route failure is slice 3.
 */
export const route = <const Name extends string, Seg extends AnySegment, ViewR, DataR>(
  name: Name,
  root: Branch<Seg, ViewR, DataR>,
): AnyRoute<ViewR | DataR> & { readonly name: Name } => ({
  name,
  searchKeys: { known: false, keys: [] },
  enter: (url) =>
    Option.map(matchUrl(root, url), (first) =>
      Effect.sync((): Entered<ViewR | DataR> => {
        let mounted = Option.none<MountedTree<ViewR>>();
        let counter = 0;
        const entered: Entered<ViewR | DataR> = {
          instance: { _tag: "RouteInstance" },
          setup: Effect.gen(function* () {
            const owner = yield* Effect.scope;
            // Forked first, so it closes last: every view closes before
            // any declaration interest is released.
            const declarations = yield* Scope.fork(owner);
            const tree: Tree = {
              declarations,
              cache: yield* Effect.serviceOption(QueryCache),
              transport: yield* Effect.serviceOption(ActorTransport),
              nextKey: (segmentName) => {
                counter += 1;
                return `${segmentName}#${String(counter)}`;
              },
            };
            const entering = yield* Effect.orDie(first.enter(tree));
            const instance = yield* entering.create(new Map(), owner);
            mounted = Option.some({ tree, root: instance });
            return yield* instance.setup;
          }),
          update: (next) =>
            Option.match(Option.all([mounted, matchUrl(root, next)]), {
              onNone: () => Effect.succeed(false),
              onSome: ([current, matched]) =>
                Effect.gen(function* () {
                  const staying = yield* Effect.orDie(matched.stay(current.root, current.tree));
                  yield* staying.commit;
                  return true;
                }),
            }),
        };
        registerInspection(
          entered,
          Effect.suspend(() =>
            Option.match(mounted, {
              onNone: () => Effect.succeed({ params: {}, search: {} }),
              onSome: (current) => deepest(current.root),
            }),
          ),
        );
        return entered;
      }),
    ),
});
