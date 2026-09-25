import type {
  AnyContract,
  AnyQuery,
  Applied,
  ArgsOf,
  Behavior,
  FollowedQuery,
  KeyOf,
  MessageOf,
  Projection,
  QueryCacheService,
  QueryEntry,
  QueryFailure,
  Refused,
  RemoteActorRef,
  RemoteCommandRef,
  ResultOf,
  SnapshotOf,
  TransportReadError,
  TransportService,
} from "effect-frame/actor";
import {
  Actor,
  ActorTransport,
  QueryCache,
  Source,
  keyOf,
  committedRevision,
  QueryState,
} from "effect-frame/actor/client";
// Relative: canonical JSON is the framework's, not a public name.
import { canonicalize } from "../actor/canonical-json.js";
import type { Node, Remote, ScopesClosed } from "effect-frame/view";
import { View } from "effect-frame/view";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  Function,
  Hash,
  Option,
  Predicate,
  RcMap,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { advance, advancedChanges } from "../actor/advance.js";
import { currentDocument } from "../actor/query-client.js";
import type { DocumentAccess } from "../actor/query-client.js";
import { heldOf, holding } from "../actor/read-ahead.js";
import { attempt } from "../view/attempt.js";
import type { Definition as LazyDefinition, Ticket } from "../view/lazy.js";
import { definitionOf as lazyDefinitionOf, withTicket } from "../view/lazy.js";
import type {
  Before,
  BeforeInput,
  Checker,
  NavigationKind,
  Redirect,
  RouteFailure,
  Verdict,
} from "./check.js";
import { Continue, register as registerChecks } from "./check.js";
import type {
  AnyRoute,
  Entered,
  ParamsCodec,
  Part,
  PathRecord,
  RouteInstance,
  RouteNavigation,
  RouteProps,
  SearchCodec,
  SearchKeyInfo,
  SearchRecord,
  SearchUpdater,
  Current,
  Decoded,
} from "./codec.js";
import { matchPrefix, segmentsOf } from "./path.js";
import {
  RouteBrand,
  address,
  parseTemplate,
  printPath,
  printSearch,
  readSearch,
  search as searchCodec,
} from "./codec.js";
import type { RouteMatch } from "./router.js";
import { Router } from "./router.js";
import type { LeaveEntry, LeaveInput, MountedRouteService } from "./leave.js";
import { MountedRoute } from "./leave.js";
import type { Candidate, LeaveKind, Question } from "./leave-registry.js";
import type { Shell } from "./landing.js";
import * as LeafRoot from "./leaf-root.js";
import type { NavigationBehavior } from "./navigation-behavior.js";
import type { DrivenServices, ErasedDriven } from "./driven.js";
import { drivenOf, drivenShell } from "./driven.js";
import type { RenderingMode } from "./rendering-mode.js";
import type {
  AnyInputs,
  InputsError,
  InputsServices,
  ParamsRecord,
  Prerendered,
  Level as PrerenderLevel,
} from "./prerender.js";
import {
  inputs as makeInputs,
  planFor,
  prerendered,
  register as registerPrerender,
} from "./prerender.js";

/**
 * The nested route model: segments, branches, and the client mode. The
 * public `Route` namespace (`route.ts`) lists what of this module is public;
 * see `docs/design/route-public.md`. The transition is described in
 * `docs/design/nested-transition.md`.
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
 *
 * Checks and failures (see `docs/design/route-checks.md`):
 *
 * - A segment's `before` check. The router runs every matched segment's
 *   check, parent first, before history moves and before this module plans
 *   anything, so a refusal starts no child check, declaration, or setup.
 * - A segment prints its own typed target with `href`.
 * - A leaf or layout may fail in setup with a typed `E`; it then needs an
 *   `errored` handler. A declared acquisition failure of the segment's own
 *   data goes to the same handler as `Declaration`. A failed instance is
 *   never stayed: the next navigation that matches it enters it again.
 *
 * Pending presentation (see `docs/design/route-pending.md`):
 *
 * - A leaf or layout may present `pending` while its entered instance
 *   prepares: a lazy import or its own suspended setup. Timing starts when
 *   the transition enters the segment, after every check continued. The
 *   fallback shows only after `after`, and once shown it stays `atLeast`
 *   unless the setup failed or the instance closed. Queries are not waited
 *   on: their readiness stays with `Loading` and the reads below it.
 * - A lazy view's import starts when the transition enters its segment,
 *   beside declaration acquisition, and its setup waits on that same
 *   attempt. The tree's first mount on the initial navigation waits for
 *   every entered import before it creates an instance, so the first frame
 *   holds imported views and never a pending fallback.
 *
 * Leave checks are internal (see `docs/design/route-leave.md`): the tree
 * answers the router's leave questions from its mounted instances, deepest
 * first. No public constructor reaches them.
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
  /**
   * Opens the reference: from `seed`, the projection a document carried,
   * when its snapshot decodes, and with the declared behavior. It answers
   * the reference and its committed projection, read at each call.
   * Internal: the behavior's types stay inside, so any contract's
   * declaration is one `Declaration`.
   */
  readonly open: (
    seed: Option.Option<Projection>,
  ) => Effect.Effect<OpenedActor, TransportReadError, ActorTransport | Scope.Scope>;
}

/** One send-only actor address a segment needs, as data: no snapshot, no stream. */
export interface CommandRefDeclaration<C extends AnyContract> {
  readonly _tag: "CommandRefDeclaration";
  readonly contract: C;
  readonly key: KeyOf<C>;
}

/** A route actor's reference, and its committed projection as a document carries it. */
export interface OpenedActor {
  readonly ref: RemoteActorRef<AnyContract>;
  readonly projection: Effect.Effect<Projection>;
}

/** A behavior a route's actor reference can predict with (see `RefOptions.behavior`). */
export type ActorBehavior<C extends AnyContract> = Behavior.Behavior<
  SnapshotOf<C>,
  MessageOf<C>,
  unknown,
  Refused
>;

/** How a route opens its actor reference. */
export interface ActorOptions<C extends AnyContract> {
  /**
   * The actor's behavior, when the client can import it: the route's
   * reference then predicts a fresh send at once, and never predicts a
   * message the behavior refuses.
   */
  readonly behavior?: ActorBehavior<C>;
}

export type Declaration =
  | QueryDeclaration<AnyQuery>
  | ActorDeclaration<AnyContract>
  | CommandRefDeclaration<AnyContract>;

/** A segment's declarations by name. */
export type Declarations = Readonly<Record<string, Declaration>>;

/** No declarations. */
export type NoDeclarations = Readonly<Record<never, never>>;

export const query = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>): QueryDeclaration<Q> => ({
  _tag: "QueryDeclaration",
  contract,
  args,
});

export const actor = <C extends AnyContract>(
  contract: C,
  key: KeyOf<C>,
  options: ActorOptions<C> = {},
): ActorDeclaration<C> => {
  const decode = Schema.decodeUnknownOption(contract.snapshot);
  const encode = Schema.encodeEffect(contract.snapshot);
  const resumeOf = (seed: Projection): Option.Option<Applied<SnapshotOf<C>>> =>
    Option.map(decode(seed.snapshot), (state) => ({
      revision: committedRevision(seed.revision),
      state,
    }));
  return {
    _tag: "ActorDeclaration",
    contract,
    key,
    open: (seed) =>
      Effect.map(
        Actor.remote(contract, key, {
          resume: Option.flatMap(seed, resumeOf),
          ...Option.match(Option.fromNullishOr(options.behavior), {
            onNone: () => ({}),
            onSome: (behavior) => ({ behavior }),
          }),
        }),
        (opened): OpenedActor => ({
          ref: opened,
          projection: Effect.flatMap(opened.applied.get, (applied) =>
            Effect.map(Effect.orDie(encode(applied.state)), (snapshot): Projection => ({
              revision: applied.revision.value,
              snapshot,
            })),
          ),
        }),
      ),
  };
};

/**
 * Declare a send-only reference to an actor: the address follows the
 * segment's params, and the transition opens, moves, and releases it as it
 * does a `Route.actor`, but it reads no snapshot and follows no stream. Use
 * it for an actor the page only commands.
 *
 * ```tsx
 * const orders = Route.segment("orders", {
 *   path: "/:tenant/orders",
 *   params: Schema.Struct({ tenant: TenantId }),
 *   data: ({ params }) => ({ book: Route.commandRef(Orders, { tenant: params.tenant }) }),
 * });
 * const fulfil = (props: Route.PropsOf<typeof orders>, id: string) =>
 *   Effect.flatMap(props.data.book.ref.get, (book) => book.send({ _tag: "Fulfil", id }));
 * ```
 */
export const commandRef = <C extends AnyContract>(
  contract: C,
  key: KeyOf<C>,
): CommandRefDeclaration<C> => ({ _tag: "CommandRefDeclaration", contract, key });

/**
 * What a view receives for a `Route.commandRef` declaration: the send-only
 * reference the transition holds now. It has `ref`, as an actor binding
 * does, and no `state`.
 */
export interface FollowedCommands<C extends AnyContract> {
  readonly ref: Source<RemoteCommandRef<C>>;
}

/**
 * What a view receives for a `Route.actor` declaration: the reference the
 * transition holds now, and the state that reference shows. A move to a new
 * key swaps the reference, and `state` follows the new one. There is no
 * `send` here: a send names its reference, so the address stays visible.
 *
 * ```tsx
 * const NotesView = (props: Route.PropsOf<typeof list>) =>
 *   Effect.gen(function* () {
 *     const add = (text: string) =>
 *       Effect.flatMap(props.data.notes.ref.get, (ref) => ref.send({ _tag: "Add", text }, options));
 *     return <ul>{View.bind(props.data.notes.state, (state) => state.items.length)}</ul>;
 *   });
 * ```
 */
export interface FollowedActor<C extends AnyContract> {
  readonly ref: Source<RemoteActorRef<C>>;
  readonly state: Source<SnapshotOf<C>>;
}

/** What a view receives for one declaration: the same `{ state }` shape for a query and an actor. */
export type BindingOf<D> =
  D extends QueryDeclaration<infer Q extends AnyQuery>
    ? FollowedQuery<ResultOf<Q>, QueryFailure>
    : D extends ActorDeclaration<infer C extends AnyContract>
      ? FollowedActor<C>
      : D extends CommandRefDeclaration<infer C extends AnyContract>
        ? FollowedCommands<C>
        : never;

/** Every binding a segment's view receives, inherited ones included. */
export type RouteData<Data extends Declarations> = {
  readonly [K in keyof Data]: BindingOf<Data[K]>;
};

/** The services a transition needs to acquire one declaration. */
export type ServicesOf<D> =
  D extends QueryDeclaration<AnyQuery>
    ? QueryCache | ActorTransport
    : D extends ActorDeclaration<AnyContract> | CommandRefDeclaration<AnyContract>
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

/** Brands a segment value: only `Route.segment` and `Route.child` make one. */
const SegmentBrand: unique symbol = Symbol.for("effect-frame/router/Segment");

/** The part of a segment every holder can read without its types. */
export interface AnySegment {
  readonly _tag: "Segment";
  readonly [SegmentBrand]: "Segment";
  readonly name: string;
  readonly parent: Option.Option<AnySegment>;
}

/** A segment with no parent: the only segment a tree can be mounted from. */
export interface RootSegment extends AnySegment {
  readonly "~root": (_: never) => true;
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
  CheckR = never,
  Root extends boolean = boolean,
  Inherited = unknown,
> extends AnySegment {
  readonly name: Name;
  /** Encoded search ownership. Unknown means an opaque codec needs a declaration. */
  readonly searchKeys: SearchKeyInfo;
  /** Print this segment's URL: every ancestor's path and this segment's search. */
  href(params: Params, search: Search): string;
  /** `href` after carrying retained keys from the current URL. A `link` destination. */
  hrefAt(current: URL, params: Params, search: Search): string;
  /** The current URL's decoded search for this segment, or its empty value. */
  searchAt(current: URL): Search;
  /**
   * How the current match relates to this segment printed with `params`:
   * `"page"` when a tree that holds this segment matched and the URL's path
   * is this segment's path printed with `params`, `"ancestor"` when the URL's
   * path starts with that printed path and continues below it, and `"none"`
   * otherwise, including other params, not-found, and another route. The
   * search never counts: a sort or a filter does not move the page.
   */
  currentAt(current: RouteMatch, params: Params): Current;
  /** Phantom: this segment's own declarations. */
  readonly "~own": (_: never) => Own;
  /** Phantom: the declarations the view sees. */
  readonly "~data": (_: never) => Data;
  /** Phantom: what this segment's check needs. */
  readonly "~check": (_: never) => CheckR;
  /** Phantom: `true` for a segment without a parent. */
  readonly "~root": (_: never) => Root;
  /**
   * Phantom: the decoded params every ancestor contributes, which a
   * prerender `Route.inputs` of this segment receives. Empty for a root.
   */
  readonly "~inherited": (_: never) => Inherited;
}

/** The params a root segment inherits: none. */
export type NoParams = Readonly<Record<never, never>>;

/**
 * What the transition reads from a segment. It is not part of the public
 * `Segment` type: a check keeps its services only through the segment's
 * phantom, so no caller can run one outside the router.
 */
interface SegmentRuntime<Params, Search, Own> {
  readonly parts: ReadonlyArray<Part>;
  /** Every ancestor's params and this segment's own, decoded from and encoded to one record. */
  readonly params: ParamsRuntime;
  /** Decode the accumulated path record and the URL search. None is a non-match. */
  decode(record: PathRecord, search: SearchRecord): Option.Option<Values<Params, Search>>;
  /** The raw path record and the encoded search: a stayed segment publishes when it changes. */
  signature(record: PathRecord, values: Values<Params, Search>): string;
  /** This segment's own declarations. Inherited ones are the parent's. */
  declare(values: Values<Params, Search>): Own;
  /**
   * The target of a search update of the current URL. The deepest matched
   * segment prints its own path; a layout keeps the current path, so its
   * update does not leave the child. Other search keys and the hash stay.
   */
  searchUpdate(current: URL, values: Values<Params, Search>, deepest: boolean): string;
  /** This segment's own check, when it has one. Its services are `CheckR`. */
  check(values: Values<Params, Search>, url: URL, kind: NavigationKind): Option.Option<Check>;
  /**
   * Print this segment's URL for a prerender page: its full params and the
   * empty search. None when the record is not this segment's params.
   */
  print(params: ParamsRecord): Option.Option<string>;
}

/**
 * A segment's whole params: its ancestors' and its own. Each segment's
 * codec decodes only the keys its own template names; the record is the
 * whole path's, and a struct codec ignores the keys it does not name.
 */
interface ParamsRuntime {
  readonly decode: (record: PathRecord) => Option.Option<ParamsRecord>;
  readonly encode: (params: ParamsRecord) => PathRecord;
  /** The params a prerender input names, when they are this segment's whole params. */
  readonly validate: (params: ParamsRecord) => Option.Option<ParamsRecord>;
}

/** Erase a decoded params value to the record the params runtime holds. */
const erasedParams = <A>(value: A): ParamsRecord =>
  // oxlint-disable-next-line effect/noAs -- a params codec decodes a record; `typedParams` restores its type.
  value as ParamsRecord;

/** Restore the params type a segment's runtime erased. */
const restoredParams = <Params>(record: ParamsRecord): Params =>
  // oxlint-disable-next-line effect/noAs -- the runtime decoded exactly the record the segment's Params names.
  record as Params;

/**
 * The params runtime of `own` under `parent`: the parent's values, then
 * this segment's. A root's params are its codec's own value, unchanged.
 */
const paramsRuntime = (parent: Option.Option<ParamsRuntime>, own: ParamsCodec): ParamsRuntime => {
  const decodeOwn = Schema.decodeUnknownOption(own);
  const validateOwn = Schema.decodeUnknownOption(Schema.toType(own));
  const mine: ParamsRuntime = {
    decode: (record) => Option.map(decodeOwn(record), erasedParams),
    encode: Schema.encodeSync(own),
    validate: (params) => Option.map(validateOwn(params), erasedParams),
  };
  return Option.match(parent, {
    onNone: () => mine,
    onSome: (above) => paramsUnder(above, mine),
  });
};

const paramsUnder = (parent: ParamsRuntime, own: ParamsRuntime): ParamsRuntime => ({
  decode: (record) =>
    Option.flatMap(parent.decode(record), (inherited) =>
      Option.map(own.decode(record), (mine) => ({ ...inherited, ...mine })),
    ),
  encode: (params) => ({ ...parent.encode(params), ...own.encode(params) }),
  validate: (params) =>
    Option.flatMap(parent.validate(params), (inherited) =>
      Option.map(own.validate(params), (mine) => ({ ...inherited, ...mine })),
    ),
});

/** A segment's params runtime at the segment's own params type. */
const typedParams = <Params>(runtime: ParamsRuntime): TypedParams<Params> => ({
  decode: (record) => Option.map(runtime.decode(record), restoredParams<Params>),
  encode: (params) => runtime.encode(erasedParams(params)),
  validate: (params) => Option.map(runtime.validate(params), restoredParams<Params>),
});

const segmentRuntimes = new WeakMap<AnySegment, SegmentRuntime<unknown, unknown, Declarations>>();

/** The runtime `makeSegment` stored for a segment. */
const segmentRuntimeOf = <Params, Search, Own extends Declarations>(
  seg: Segment<string, Params, Search, Own, Declarations, unknown>,
): SegmentRuntime<Params, Search, Own> =>
  Option.getOrThrowWith(
    Option.map(
      Option.fromNullishOr(segmentRuntimes.get(seg)),
      // oxlint-disable-next-line effect/noAs -- makeSegment stored this runtime under this segment with these types.
      (runtime) => runtime as SegmentRuntime<Params, Search, Own>,
    ),
    () =>
      BranchRejected.make({
        segment: seg.name,
        reason: "not a segment built by Route.segment or Route.child",
      }),
  );

/** A segment's own path parts. */
const partsOf = (seg: AnySegment): ReadonlyArray<Part> =>
  Option.match(Option.fromNullishOr(segmentRuntimes.get(seg)), {
    onNone: () => [],
    onSome: (runtime) => runtime.parts,
  });

/**
 * Trees that hold each segment, by name. A segment is current only while
 * one of them is the router's match.
 */
const treesOf = new WeakMap<AnySegment, Set<string>>();

/**
 * One check, ready to run. Its services move from the Effect to the
 * segment's phantom `CheckR`, which every branch above it carries in
 * `DataR`; `route` widens them back where it registers the tree's checks.
 */
type Check = Effect.Effect<Verdict, never>;

/** Move a check's services to the phantom. See `Check`. */
// @effect-diagnostics unsafeEffectTypeAssertion:off
const erase = <CheckR>(check: Effect.Effect<Verdict, never, CheckR>): Check =>
  // oxlint-disable-next-line effect/noAs -- CheckR is carried by the segment's phantom and reaches the route's DataR.
  check as Check;
// @effect-diagnostics unsafeEffectTypeAssertion:error

export interface SegmentOptions<
  Path extends string,
  P extends ParamsCodec,
  S extends SearchCodec,
  Own,
  CheckR,
  Params = P["Type"],
> {
  /** A template relative to the parent. The URLPattern grammar that prints. */
  readonly path: Path;
  /**
   * Decodes this segment's own params: exactly the names its template
   * declares, as a struct. An ancestor's params are the ancestor's; the
   * view, `data`, and `before` see them all. Absent when the template
   * declares none.
   */
  readonly params?: P;
  readonly search?: S;
  /** Encoded search keys for an opaque codec such as a custom SearchRecord. */
  readonly searchKeys?: ReadonlyArray<string>;
  /** Search keys to carry when this segment is linked to without a caller value. */
  readonly retain?: ReadonlyArray<Extract<keyof S["Type"], string>>;
  readonly data?: (values: Values<Params, S["Type"]>) => Own;
  /**
   * Asked on every proposed navigation that matches this segment, entering
   * or stayed, after every ancestor continued. Not asked for a same-URL or
   * fragment-only move. It sees the candidate's values; no data is open.
   */
  readonly before?: Before<Params, S["Type"], CheckR>;
}

/** The param names a path template declares: `:name` and `:name*`. */
export type ParamNames<Path extends string> = Path extends `${infer Head}/${infer Rest}`
  ? ParamName<Head> | ParamNames<Rest>
  : ParamName<Path>;

type ParamName<Text extends string> = Text extends `:${infer Name}*`
  ? Name
  : Text extends `:${infer Name}`
    ? Name
    : never;

/** What a params codec that does not match its template is told. */
export interface ParamsMismatch<Names> {
  readonly "~the params codec must encode exactly the template's params": Names;
}

/**
 * `params` is required when the template declares a param, and its encoded
 * keys are exactly the template's names: a name the template lacks, or a
 * template name the codec lacks, does not compile. A template that is not a
 * literal type is not checked.
 */
type ParamsMatch<Path extends string, P extends ParamsCodec> = string extends Path
  ? unknown
  : [ParamNames<Path>] extends [never]
    ? [keyof P["Encoded"]] extends [never]
      ? unknown
      : { readonly params: ParamsMismatch<never> }
    : [
          Exclude<keyof P["Encoded"], ParamNames<Path>>,
          Exclude<ParamNames<Path>, keyof P["Encoded"]>,
        ] extends [never, never]
      ? { readonly params: unknown }
      : { readonly params: ParamsMismatch<ParamNames<Path>> };

/** A parent's params and a child's own, as one flat record type. */
export type MergeParams<Parent, Own> = {
  readonly [K in keyof Parent | keyof Own]: K extends keyof Own
    ? Own[K]
    : K extends keyof Parent
      ? Parent[K]
      : never;
};

const NoParamsCodec = Schema.Struct({});
type NoParamsCodec = typeof NoParamsCodec;

/** A segment's params runtime at the segment's own params type. */
interface TypedParams<Params> {
  readonly decode: (record: PathRecord) => Option.Option<Params>;
  readonly encode: (params: Params) => PathRecord;
  readonly validate: (params: ParamsRecord) => Option.Option<Params>;
}

/**
 * `data` is optional only while `Own` is empty, so a segment given its
 * declaration type explicitly must also say how to build it.
 */
type DataRequired<Own> = [NoDeclarations] extends [Own] ? unknown : { readonly data: unknown };

const NoSearch = searchCodec(Schema.Struct({}));
type NoSearch = typeof NoSearch;

const phantom =
  <A>() =>
  (value: never): A =>
    value;

const noDeclarations = (): NoDeclarations => ({});

/** A prerender page carries no search: its URL prints the empty one. */
const prerenderBase = new URL("http://prerender.invalid/");

/** A stable printed form of a path record, used only to compare two matches. */
const recordSignature = (record: PathRecord): string =>
  Object.keys(record)
    .toSorted()
    .map((key) => {
      const value = Option.getOrElse(Option.fromNullishOr(record[key]), () => "");
      return `${encodeURIComponent(key)}=${[value].flat().map(encodeURIComponent).join("/")}`;
    })
    .join("&");

/** Every part from the root to this segment, in order. */
const pathOf = (segment: AnySegment): ReadonlyArray<Part> => [
  ...Option.match(segment.parent, { onNone: () => [], onSome: pathOf }),
  ...partsOf(segment),
];

const makeSegment = <
  const Name extends string,
  Params,
  S extends SearchCodec,
  Own extends Declarations,
  Data extends Declarations,
  CheckR,
  Root extends boolean,
  Inherited,
>(
  name: Name,
  parent: Option.Option<AnySegment>,
  options: SegmentOptions<string, ParamsCodec, S, Own, CheckR, Params>,
  data: (values: Values<Params, S["Type"]>) => Own,
): Segment<Name, Params, S["Type"], Own, Data, CheckR, Root, Inherited> => {
  const parts = Result.getOrThrowWith(parseTemplate(options.path), (rejected) => rejected);
  const params = paramsRuntime(
    Option.flatMap(parent, (above) =>
      Option.map(Option.fromNullishOr(segmentRuntimes.get(above)), (runtime) => runtime.params),
    ),
    Option.getOrElse(Option.fromNullishOr(options.params), (): ParamsCodec => NoParamsCodec),
  );
  // The whole params type is `Params`: the ancestors' and this segment's own.
  const typed = typedParams<Params>(params);
  const search: SearchCodec = Option.getOrElse(
    Option.fromNullishOr(options.search),
    () => NoSearch,
  );
  const decodeSearch = Schema.decodeUnknownOption(search);
  const encodeSearch = Schema.encodeUnknownSync(search);
  const before = Option.fromNullishOr(options.before);
  const full = [...Option.match(parent, { onNone: () => [], onSome: pathOf }), ...parts];
  // One address prints and parses the whole path.
  const printer = address<Params, SearchCodec>(full, {
    decodeParams: typed.decode,
    encodeParams: typed.encode,
    search,
    searchKeys: Option.fromNullishOr(options.searchKeys),
    retain: Option.fromNullishOr(options.retain),
  });
  const made: Segment<Name, Params, S["Type"], Own, Data, CheckR, Root, Inherited> = {
    _tag: "Segment",
    [SegmentBrand]: "Segment",
    name,
    parent,
    searchKeys: printer.searchKeys,
    href: printer.href,
    hrefAt: printer.hrefAt,
    searchAt: printer.searchAt,
    currentAt: (current: RouteMatch, linked: Params): Current => {
      const trees = Option.fromNullishOr(treesOf.get(made));
      if (!Option.exists(trees, (names) => names.has(current.name))) {
        return "none";
      }
      // Both sides print through the same codec, so equal params print one path.
      const path = printPath(full, typed.encode(linked));
      const printed = (decoded: Decoded<Params, SearchCodec["Type"]>): boolean =>
        printPath(full, typed.encode(decoded.params)) === path;
      if (Option.exists(printer.parse(current.url), printed)) {
        return "page";
      }
      if (Option.exists(printer.parsePrefix(current.url), printed)) {
        return "ancestor";
      }
      return "none";
    },
    "~own": phantom<Own>(),
    "~data": phantom<Data>(),
    "~check": phantom<CheckR>(),
    "~root": phantom<Root>(),
    "~inherited": phantom<Inherited>(),
  };
  const runtime: SegmentRuntime<Params, S["Type"], Own> = {
    parts,
    params,
    print: (values) =>
      Option.map(typed.validate(values), (valid) =>
        printer.href(valid, printer.searchAt(prerenderBase)),
      ),
    searchUpdate: (current, values, deepest) => {
      if (deepest) {
        return printer.hrefFrom(current, values.params, values.search);
      }
      return printer.searchFrom(current, values.search);
    },
    check: (values, url, kind) => Option.map(before, (ask) => erase(ask({ ...values, url, kind }))),
    decode: (record, searchRecord) =>
      Option.flatMap(typed.decode(record), (decoded) =>
        Option.flatMap(decodeSearch(searchRecord), (searchValue) =>
          Option.some({ params: decoded, search: searchValue }),
        ),
      ),
    signature: (record, values) =>
      `${recordSignature(record)}${printSearch(encodeSearch(values.search))}`,
    declare: data,
  };
  segmentRuntimes.set(made, runtime);
  return made;
};

/**
 * A root segment: an address with no parent. `params` decodes exactly the
 * names the template declares, and is absent when it declares none.
 *
 * ```ts
 * const tenant = Route.segment("tenant", {
 *   path: "/app/:tenant",
 *   params: Schema.Struct({ tenant: Schema.String }),
 * });
 * const home = Route.segment("home", { path: "/" });
 * ```
 */
export const segment = <
  const Name extends string,
  const Path extends string,
  P extends ParamsCodec = NoParamsCodec,
  S extends SearchCodec = NoSearch,
  Own extends Declarations = NoDeclarations,
  CheckR = never,
>(
  name: Name,
  options: SegmentOptions<Path, P, S, Own, CheckR> & DataRequired<Own> & ParamsMatch<Path, P>,
): Segment<Name, P["Type"], S["Type"], Own, Own, CheckR, true, NoParams> =>
  makeSegment<Name, P["Type"], S, Own, Own, CheckR, true, NoParams>(
    name,
    Option.none(),
    options,
    Option.getOrElse(Option.fromNullishOr(options.data), () => (): Own => ownEmpty<Own>()),
  );

/**
 * A segment under a parent. Its template is relative to the parent's, and
 * `params` decodes only the names its own template declares: the parent's
 * params are inherited, and the view, `data`, and `before` see them all.
 * It inherits the parent's declarations.
 *
 * ```ts
 * const post = Route.child(tenant, "post", {
 *   path: "posts/:postId",
 *   params: Schema.Struct({ postId: Schema.String }),
 * });
 * // post's params: { tenant: string; postId: string }
 * ```
 */
export const child = <
  ParentParams,
  ParentData extends Declarations,
  const Name extends string,
  const Path extends string,
  P extends ParamsCodec = NoParamsCodec,
  S extends SearchCodec = NoSearch,
  Own extends Declarations & Disjoint<ParentData> = NoDeclarations,
  CheckR = never,
>(
  parent: Segment<string, ParentParams, unknown, Declarations, ParentData, unknown>,
  name: Name,
  options: SegmentOptions<Path, P, S, Own, CheckR, MergeParams<ParentParams, P["Type"]>> &
    DataRequired<Own> &
    ParamsMatch<Path, P>,
): Segment<
  Name,
  MergeParams<ParentParams, P["Type"]>,
  S["Type"],
  Own,
  ParentData & Own,
  CheckR,
  false,
  ParentParams
> => {
  const made = makeSegment<
    Name,
    MergeParams<ParentParams, P["Type"]>,
    S,
    Own,
    ParentData & Own,
    CheckR,
    false,
    ParentParams
  >(
    name,
    Option.some(parent),
    options,
    Option.getOrElse(Option.fromNullishOr(options.data), () => (): Own => ownEmpty<Own>()),
  );
  // The path record is accumulated from the root, so a repeated name would
  // silently replace the ancestor's value. Reject it where it is declared.
  for (const param of paramNames(partsOf(made))) {
    const owner = ancestorWithParam(Option.some(parent), param);
    if (Option.isSome(owner)) {
      return Option.getOrThrowWith(Option.none(), () =>
        BranchRejected.make({
          segment: name,
          reason: `path param ${param} is already declared by ${owner.value.name}`,
        }),
      );
    }
  }
  return made;
};

const paramNames = (parts: ReadonlyArray<Part>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    if (part._tag === "Literal") {
      return [];
    }
    return [part.name];
  });

/** The nearest ancestor whose own path declares `param`. */
const ancestorWithParam = (
  from: Option.Option<AnySegment>,
  param: string,
): Option.Option<AnySegment> =>
  Option.flatMap(from, (current) => {
    if (paramNames(partsOf(current)).includes(param)) {
      return Option.some(current);
    }
    return ancestorWithParam(current.parent, param);
  });

/**
 * A segment without a data function declares nothing. Its `Own` is then the
 * default empty record, so the empty object is exactly that type.
 */
const ownEmpty = <Own>(): Own => {
  const empty: unknown = noDeclarations();
  // oxlint-disable-next-line effect/noAs -- Own defaults to NoDeclarations when data is absent.
  return empty as Own;
};

// ---------------------------------------------------------------------------
// Views and branches
// ---------------------------------------------------------------------------

/**
 * What a segment's view receives: the route's props and the segment's
 * data. Sources, so a stayed segment re-runs nothing. `href` prints this
 * segment; `pushSearch` and `replaceSearch` update its search against the
 * latest URL and are refused once this instance's route is gone.
 */
export interface SegmentProps<Params, Search, Data extends Declarations> extends RouteProps<
  Params,
  Search
> {
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
  Seg extends Segment<string, infer P, infer S, Declarations, infer Data, unknown>
    ? SegmentProps<P, S, Data>
    : never;

export type LayoutPropsOf<Seg, ChildR> =
  Seg extends Segment<string, infer P, infer S, Declarations, infer Data, unknown>
    ? LayoutProps<P, S, Data, ChildR>
    : never;

/**
 * What a segment shows when it fails. It receives the failure as a Source,
 * so a new attempt can publish into it without running this handler again.
 */
export interface Recovery<E> {
  readonly errored: (failure: Source<RouteFailure<E>>) => Node;
  readonly pending?: Pending;
}

/**
 * What an entered instance shows while it prepares: its lazy import and its
 * own suspended setup. Queries are not preparation; `Loading` owns them.
 *
 * - `after`: how long preparation may take before `fallback` shows. Work
 *   that finishes sooner never shows it.
 * - `atLeast`: how long a shown fallback stays, at least. A failed setup and
 *   a closed instance do not wait for it.
 *
 * Both are read with the Effect `Clock`. There are no defaults.
 */
export interface Pending {
  readonly fallback: Node;
  readonly after: Duration.Input;
  readonly atLeast: Duration.Input;
}

/**
 * The options of a view that cannot fail. `errored` handles only its
 * declaration failures, and `pending` presents its preparation.
 */
export interface Presentation {
  readonly errored?: (failure: Source<RouteFailure<never>>) => Node;
  readonly pending?: Pending;
}

/**
 * The options argument. A view that cannot fail may omit it, or any part of
 * it; its declaration failures then fail the navigation when it has no
 * `errored`. A view that can fail with `E` must handle exactly that `E`.
 */
export type RecoveryFor<E> = [E] extends [never]
  ? readonly [] | readonly [options: Presentation]
  : readonly [options: Recovery<E>];

/**
 * What only a leaf may say (#31): how a navigation to it lands. Absent, the
 * router's default applies. A layout has no such option, so
 * `Route.layout(..., { landing })` does not compile. The name is not
 * `behavior`: that word is an actor's reducer (`Route.actor(c, k, { behavior })`).
 *
 * @example
 * ```ts
 * Route.leaf(tabs, TabsView, { landing: NavigationBehavior.Preserve });
 * ```
 */
export interface LeafOptions {
  readonly landing?: NavigationBehavior;
}

/** A leaf's options argument: `RecoveryFor<E>` plus `LeafOptions`. */
export type LeafOptionsFor<E> = [E] extends [never]
  ? readonly [] | readonly [options: Presentation & LeafOptions]
  : readonly [options: Recovery<E> & LeafOptions];

/** The leaf's own landing, when its options name one. */
const landingOf = (options: ReadonlyArray<LeafOptions>): Option.Option<NavigationBehavior> =>
  Option.flatMap(Option.fromNullishOr(options[0]), (one) => Option.fromNullishOr(one.landing));

/** Which branch made an instance. Compared by reference. */
interface BranchIdentity {
  readonly segment: string;
}

/**
 * A mounted segment. `R` is its view's requirements. It appears only in
 * output positions, so a child branch widens into its layout's union.
 */
interface Instance<R> {
  readonly key: string;
  readonly branch: BranchIdentity;
  /** The view's setup, owned by this instance's view Scope. */
  readonly setup: Effect.Effect<Node, never, R>;
  /**
   * Its setup presents a `pending` fallback, timed from when the setup
   * starts. The outlet then starts it in its row, when the parent is drawn.
   */
  readonly presents: boolean;
  /** Close descendants, the view, and the bindings, in that order. */
  readonly close: Effect.Effect<void>;
  /** Release this instance's and its descendants' declaration interests. */
  readonly release: Effect.Effect<void>;
  /** The current decoded values, for inspection. */
  readonly values: Effect.Effect<Values<unknown, unknown>>;
  /** The current child instance, for inspection. */
  readonly child: Effect.Effect<Option.Option<Instance<unknown>>>;
  /** It shows `errored`. A failed instance is entered again, never stayed. */
  readonly failed: () => boolean;
  /** The leaf's own navigation behavior. None: a layout, or the router's default. */
  readonly behavior: Option.Option<NavigationBehavior>;
  /** The host node at this leaf's root while it is drawn. Always None for a layout. */
  readonly root: Effect.Effect<Option.Option<unknown>>;
  /**
   * Completes when this instance's own part of the shell is drawn: true
   * when its view drew (its outlet can draw below it), false when a pending
   * fallback stands for it or its setup ended without a view.
   */
  readonly drawn: Effect.Effect<boolean>;
  /**
   * Completes once every query this instance declares has settled: its
   * current entry left `Loading`, `Ready` or `Failed`. An actor binding is
   * settled when it is bound (`Actor.remote` waited for its first snapshot). Read
   * at the moment it runs, so it follows a binding the transition moved.
   */
  readonly settled: Effect.Effect<void>;
  /**
   * The leave checks this instance and its descendants would ask for a
   * candidate whose matched outline at this slot is `next`, deepest first.
   */
  readonly questions: (
    next: Option.Option<Outline>,
    destination: URL,
    kind: LeaveKind,
  ) => Effect.Effect<ReadonlyArray<Question>>;
}

/**
 * A candidate's matched branch, as values: what leave questions compare,
 * and what a search update reads back.
 */
interface Outline {
  readonly branch: BranchIdentity;
  readonly record: PathRecord;
  readonly values: Values<unknown, unknown>;
  readonly signature: string;
  readonly child: Option.Option<Outline>;
}

/** A tree mounted once: the Scope its declarations live under and its services. */
interface TreeState {
  /** The router's moves for this mounted route, and its identity for them. */
  readonly navigation: RouteNavigation;
  readonly instance: RouteInstance;
  /** Match a URL against the whole tree. */
  readonly outline: (url: URL) => Option.Option<Outline>;
  readonly declarations: Scope.Scope;
  /**
   * True only in a server render of an `SSR` tree: a query interest waits
   * until its entry settles before the transition goes on. See
   * `ResolveBeforeRender`.
   */
  readonly resolve: boolean;
  readonly cache: Option.Option<QueryCacheService>;
  readonly transport: Option.Option<TransportService>;
  /**
   * The tree's route actor references, one per address (#37): every
   * declaration of one actor in the tree shares one reference, held while
   * any of them is. So a layout and its leaf draw the same revision, and the
   * document carries one seed for it.
   */
  readonly actors: RcMap.RcMap<ActorKey, RemoteActorRef<AnyContract>, TransportReadError>;
  readonly nextKey: (name: string) => string;
  /**
   * Serializes a transition with a setup failure's cleanup. Both change
   * which child an instance holds; the router already serializes
   * transitions among themselves, but a setup fails on a row's own fiber.
   */
  readonly lock: Semaphore.Semaphore;
  /**
   * Whether an instance created now may present `pending`. False while the
   * tree's first mount on the initial navigation creates its instances:
   * that first frame waits for imports and setup instead. True afterwards,
   * and from the start for a tree entered by a later navigation.
   */
  present: boolean;
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

/**
 * What a transition does with one slot. A stayed segment whose own move
 * failed into its `errored` handler is entered again as a failed instance.
 */
type Plan<R> =
  | { readonly _tag: "Stay"; readonly staying: Staying }
  | { readonly _tag: "Enter"; readonly entering: Entering<R> };

type ChildPlan<R> = Plan<R> | { readonly _tag: "None" };

/** One matched segment and the matched remainder of its branch. */
interface Match<R> {
  readonly branch: BranchIdentity;
  /** The candidate's matched values from this segment down. */
  readonly outline: Outline;
  /** Every matched segment's check for this candidate, parent first. */
  readonly check: (url: URL, kind: NavigationKind) => Check;
  enter(tree: TreeState): Effect.Effect<Entering<R>, TransportReadError>;
  stay(instance: Instance<unknown>, tree: TreeState): Effect.Effect<Plan<R>, TransportReadError>;
}

interface MatchInput {
  readonly segments: ReadonlyArray<string>;
  readonly index: number;
  readonly record: PathRecord;
  readonly search: SearchRecord;
}

/** Brands a branch value: only `Route.leaf` and `Route.layout` make one. */
const BranchBrand: unique symbol = Symbol.for("effect-frame/router/Branch");

/**
 * A segment with its view and children. `ViewR` is what its view needs,
 * including every child's view requirements that the outlet carries.
 * `DataR` is what its transition needs: declarations and checks.
 */
export interface Branch<Seg extends AnySegment, ViewR, DataR> {
  readonly _tag: "Branch";
  readonly [BranchBrand]: "Branch";
  readonly segment: Seg;
  /** Phantom: what the branch's views need. */
  readonly "~view": (_: never) => ViewR;
  /** Phantom: what the branch's transition needs: declarations and checks. */
  readonly "~data": (_: never) => DataR;
}

/** Any branch with view requirements `R`. */
export type AnyBranch<R> = Branch<AnySegment, R, unknown>;

/**
 * What the transition reads from a branch. It is not part of the public
 * `Branch` type, so no instance, plan, or leave question is named there.
 */
interface BranchRuntime<R> {
  match(input: MatchInput): Option.Option<Match<R>>;
  /** Search ownership of this segment and every descendant. */
  readonly searchKeys: ReadonlyArray<SearchKeyInfo>;
  /** This segment and every descendant. */
  readonly segments: ReadonlyArray<AnySegment>;
  /** This segment and its children, as a prerender build walks them. */
  readonly level: PrerenderLevel;
  /** Every leaf at or below this branch, as `Route.driven` checks them. */
  readonly leaves: ReadonlyArray<Leaf>;
}

const runtimes = new WeakMap<object, BranchRuntime<unknown>>();

/**
 * The runtime `makeBranch` stored for a branch. A constructor chose the
 * phantom `R` as a superset of what the runtime's instances need, so the
 * read keeps its services.
 */
const runtimeOf = <R>(branch: AnyBranch<R>): BranchRuntime<R> =>
  Option.getOrThrowWith(
    Option.map(
      Option.fromNullishOr(runtimes.get(branch)),
      // oxlint-disable-next-line effect/noAs -- makeBranch stored this runtime under this branch; its constructor chose R.
      (runtime) => runtime as BranchRuntime<R>,
    ),
    () =>
      BranchRejected.make({
        segment: branch.segment.name,
        reason: "not a branch built by Route.leaf or Route.layout",
      }),
  );

export type ViewROf<B> = B extends Branch<AnySegment, infer R, unknown> ? R : never;
export type DataROf<B> = B extends Branch<AnySegment, unknown, infer R> ? R : never;
/**
 * What a view needs beyond what its instance provides: its Scope and
 * `MountedRoute`. Not exported, so the public declarations never name a
 * leave service; `leave-branch.ts` spells the same type.
 */
type ViewServices<R> = Exclude<Exclude<R, MountedRoute>, Scope.Scope>;

export type OwnServices<Seg> =
  Seg extends Segment<string, unknown, unknown, infer Own, Declarations, infer CheckR>
    ? ServicesOf<Own[keyof Own]> | CheckR
    : never;

/**
 * Build a leaf whose phantom view services are `ViewR`. The public `leaf`
 * claims the view's services without `Scope`, which every instance
 * provides. An internal variant removes one more service it provides.
 */
export const buildLeaf = <
  ViewR,
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  R,
  CheckR,
  E,
  Root extends boolean = boolean,
>(
  seg: Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  view: (props: SegmentProps<Params, Search, Data>) => Effect.Effect<Node, E, R>,
  options: ReadonlyArray<(Recovery<E> | Presentation) & LeafOptions>,
): Branch<
  Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  ViewR,
  OwnServices<Segment<Name, Params, Search, Own, Data, CheckR, Root>>
> => {
  const driven = drivenOf(view);
  return makeBranch<Name, Params, Search, Own, Data, CheckR, E, R, never, ViewR, Root>(
    seg,
    [],
    (props) => view(props),
    {
      ...boundaryOf<E>(options),
      setupShell: Option.match(driven, {
        onNone: () => (failed: Node) => failed,
        onSome: () => drivenShell,
      }),
    },
    lazyDefinitionOf(view),
    landingOf(options),
    driven,
  );
};

/**
 * A leaf, and the identity its outlines carry. Sibling segments may share a
 * name, so a leaf is found by its identity, never by its name.
 */
interface Leaf {
  readonly identity: BranchIdentity;
  /** What the leaf draws over the op wire, when its view is a `Route.drivenView`. */
  readonly driven: Option.Option<ErasedDriven>;
}

/** A branch with no children is its own leaf; a layout's are its children's. */
const leavesOf = (
  leaf: Leaf,
  children: ReadonlyArray<BranchRuntime<unknown>>,
): ReadonlyArray<Leaf> => {
  if (children.length === 0) {
    return [leaf];
  }
  return children.flatMap((below) => below.leaves);
};

/** A leaf segment: it has no outlet. */
export const leaf = <
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  R,
  // Defaults, because TypeScript drops `never` as an inference candidate.
  CheckR = never,
  E = never,
  Root extends boolean = boolean,
>(
  seg: Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  view: (props: SegmentProps<Params, Search, Data>) => Effect.Effect<Node, E, R>,
  ...options: LeafOptionsFor<E>
): Branch<
  Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  Exclude<R, Scope.Scope>,
  OwnServices<Segment<Name, Params, Search, Own, Data, CheckR, Root>>
> =>
  buildLeaf<Exclude<R, Scope.Scope>, Name, Params, Search, Own, Data, R, CheckR, E, Root>(
    seg,
    view,
    options,
  );

/** Build a layout whose phantom view services are `ViewR`. See `buildLeaf`. */
export const buildLayout = <
  ViewR,
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  Children extends ReadonlyArray<AnyBranch<unknown>>,
  R,
  CheckR,
  E,
  Root extends boolean = boolean,
>(
  seg: Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  children: Children,
  view: (
    props: LayoutProps<Params, Search, Data, ViewROf<Children[number]>>,
  ) => Effect.Effect<Node, E, R>,
  recovery: ReadonlyArray<Recovery<E> | Presentation>,
): Branch<
  Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  ViewR,
  OwnServices<Segment<Name, Params, Search, Own, Data, CheckR, Root>> | DataROf<Children[number]>
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
  if (partsOf(seg).some((part) => part._tag === "Tail")) {
    return Option.getOrThrowWith(Option.none(), () =>
      BranchRejected.make({ segment: seg.name, reason: "a layout cannot end in a tail" }),
    );
  }
  // oxlint-disable-next-line effect/noAs -- the children tuple is exactly ViewROf<Children[number]>'s branches.
  const typed = children as ReadonlyArray<AnyBranch<ViewROf<Children[number]>>>;
  return makeBranch<
    Name,
    Params,
    Search,
    Own,
    Data,
    CheckR,
    E,
    R,
    ViewROf<Children[number]>,
    ViewR,
    Root
  >(
    seg,
    typed,
    (props, outlet) => view({ ...props, outlet }),
    boundaryOf<E>(recovery),
    lazyDefinitionOf(view),
    Option.none(),
    Option.none(),
  );
};

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
  // Defaults, because TypeScript drops `never` as an inference candidate.
  CheckR = never,
  E = never,
  Root extends boolean = boolean,
>(
  seg: Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  children: Children,
  view: (
    props: LayoutProps<Params, Search, Data, ViewROf<Children[number]>>,
  ) => Effect.Effect<Node, E, R>,
  ...recovery: RecoveryFor<E>
): Branch<
  Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  Exclude<R, Scope.Scope>,
  OwnServices<Segment<Name, Params, Search, Own, Data, CheckR, Root>> | DataROf<Children[number]>
> =>
  buildLayout<
    Exclude<R, Scope.Scope>,
    Name,
    Params,
    Search,
    Own,
    Data,
    Children,
    R,
    CheckR,
    E,
    Root
  >(seg, children, view, recovery);

/** The options argument, read once: each part is present or absent. */
interface Boundary<E> {
  readonly errored: Option.Option<(failure: Source<RouteFailure<E>>) => Node>;
  readonly pending: Option.Option<Timed>;
  /**
   * What holds `errored` when the view's own setup failed. A driven leaf's
   * view draws its container on the client whatever the server drew, so its
   * setup failure is drawn inside that container, where hydration keeps it.
   */
  readonly setupShell: (failed: Node) => Node;
}

/** `Pending` with its durations decoded once, where the branch is defined. */
interface Timed {
  readonly fallback: Node;
  readonly after: Duration.Duration;
  readonly atLeast: Duration.Duration;
}

const timed = (pending: Pending): Timed => ({
  fallback: pending.fallback,
  after: Duration.fromInputUnsafe(pending.after),
  atLeast: Duration.fromInputUnsafe(pending.atLeast),
});

/**
 * The optional options argument as Options. `RecoveryFor` already made
 * `errored` required whenever `E` is not `never`.
 */
const boundaryOf = <E>(recovery: ReadonlyArray<Recovery<E> | Presentation>): Boundary<E> => {
  const given = Option.fromNullishOr(recovery[0]);
  return {
    errored: Option.flatMap(given, (one) =>
      Option.map(
        Option.fromNullishOr(one.errored),
        // A Presentation handles only declaration failures; it never sees Setup.
        // oxlint-disable-next-line effect/noAs -- errored only reads RouteFailure<E>, and E is never whenever a Presentation was accepted.
        (errored) => errored as (failure: Source<RouteFailure<E>>) => Node,
      ),
    ),
    pending: Option.map(
      Option.flatMap(given, (one) => Option.fromNullishOr(one.pending)),
      timed,
    ),
    setupShell: (failed) => failed,
  };
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
  | Addressed;

/** An actor address a binding holds: a full reference, or a send-only one. */
type Addressed =
  | { readonly _tag: "Actor"; readonly ref: RemoteActorRef<AnyContract> }
  | { readonly _tag: "Commands"; readonly ref: RemoteCommandRef<AnyContract> };

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

/** The prefix of an address declaration's key: a full reference and a send-only one never share an interest. */
const declarationKinds = {
  ActorDeclaration: "actor",
  CommandRefDeclaration: "commands",
} satisfies Readonly<
  Record<ActorDeclaration<AnyContract>["_tag"] | CommandRefDeclaration<AnyContract>["_tag"], string>
>;

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
  const kind = declarationKinds[declaration._tag];
  return Effect.map(
    Effect.orDie(Schema.encodeUnknownEffect(declaration.contract.key)(declaration.key)),
    (encoded) =>
      `${kind}:${declaration.contract.name}@${String(declaration.contract.version)}/${canonicalize(encoded)}`,
  );
};

const missing = (service: string) =>
  Effect.die(`declared route data needs ${service} where the tree is mounted`);

/**
 * One route actor's address in a tree, with what opens it. Keys are equal
 * by address: the first declaration that opens the address opens the
 * shared reference, and a later one of the same address shares it.
 */
interface ActorKey extends Equal.Equal {
  readonly id: string;
  readonly declaration: ActorDeclaration<AnyContract>;
  readonly transport: TransportService;
}

const actorKey = (
  id: string,
  declaration: ActorDeclaration<AnyContract>,
  transport: TransportService,
): ActorKey => ({
  id,
  declaration,
  transport,
  [Equal.symbol]: (that: Equal.Equal) => Predicate.hasProperty(that, "id") && that.id === id,
  [Hash.symbol]: () => Hash.string(id),
});

/**
 * Open one route actor's reference (#37), once for every declaration of
 * its address in the tree. On the client, while the page hydrates, from
 * the snapshot the server's document carried for it: the first frame holds
 * the actor and nothing reads it again. Without one, the reference reads
 * the actor. On the server, the reference's committed snapshot is held for
 * the document while the reference is open, and read again at each write,
 * so the seed agrees with the drawing. One reference per address means one
 * revision drawn and one seed: two references could each draw their own
 * revision, and the client could resume only one of them.
 */
const openSharedActor =
  (document: Option.Option<DocumentAccess>) =>
  (key: ActorKey): Effect.Effect<RemoteActorRef<AnyContract>, TransportReadError, Scope.Scope> =>
    Effect.gen(function* () {
      const seeded = yield* Option.match(document, {
        onNone: () => Effect.succeed(Option.none<Projection>()),
        onSome: (found) => found.actorSeed(key.id),
      });
      const opened = yield* key.declaration
        .open(seeded)
        .pipe(Effect.provideService(ActorTransport, key.transport));
      if (Option.isSome(document)) {
        yield* document.value.holdActor(key.id, opened.projection);
      }
      return opened.ref;
    });

const openActor = (
  tree: TreeState,
  id: string,
  declaration: ActorDeclaration<AnyContract>,
  transport: TransportService,
): Effect.Effect<RemoteActorRef<AnyContract>, TransportReadError, Scope.Scope> =>
  RcMap.get(tree.actors, actorKey(id, declaration, transport));

const open = (
  tree: TreeState,
  id: string,
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
      if (declaration._tag === "CommandRefDeclaration") {
        return Effect.map(
          Actor.remoteCommands(declaration.contract, declaration.key).pipe(
            Effect.provideService(ActorTransport, transport),
          ),
          (opened): Resource => ({ _tag: "Commands", ref: opened }),
        );
      }
      return Effect.map(openActor(tree, id, declaration, transport), (opened): Resource => ({
        _tag: "Actor",
        ref: opened,
      }));
    },
  });

/**
 * Server only, `SSR` mode (#18 §3.3): a route's declared data is resolved
 * before the render pass. The server document provides `true`, and a
 * transition then waits, in each query's own acquisition, until the entry
 * settles. The acquisitions run in parallel, so the branch waits for its
 * slowest query, not for their sum. The document bounds the whole
 * preparation with its time limit (`renderDocument`). The client never
 * provides it: a client navigation is never blocked on data.
 */
export const ResolveBeforeRender = Context.Reference<boolean>(
  "effect-frame/router/branch/ResolveBeforeRender",
  { defaultValue: () => false },
);

/** Wait for a query entry to leave `Loading`, when the tree resolves before render. */
const resolved = (tree: TreeState, resource: Resource): Effect.Effect<void> => {
  // `Actor.remote` already waited for an actor's first snapshot.
  if (!tree.resolve || resource._tag !== "Query") {
    return Effect.void;
  }
  return resource.entry.state.changes.pipe(
    Stream.filter((state) => state._tag !== "Loading"),
    Stream.take(1),
    Stream.runDrain,
  );
};

/**
 * Completes once one acquired interest has settled. A query entry settles
 * when it leaves `Loading`, either way; an actor ref already holds its
 * first snapshot.
 */
const settledRead = (acquired: Acquired): Effect.Effect<void> => {
  if (acquired.resource._tag !== "Query") {
    return Effect.void;
  }
  return acquired.resource.entry.state.changes.pipe(
    Stream.filter((state) => state._tag !== "Loading"),
    Stream.take(1),
    Stream.runDrain,
  );
};

/**
 * Acquire one interest in a fresh Scope under the declaration root. A
 * failure closes that Scope before it is reported.
 */
const acquire = (
  tree: TreeState,
  key: string,
  declaration: Declaration,
): Effect.Effect<Acquired, TransportReadError> =>
  Effect.flatMap(Scope.fork(tree.declarations), (scope) =>
    Scope.provide(open(tree, key, declaration), scope).pipe(
      Effect.tap((resource) => resolved(tree, resource)),
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
    return QueryState.Ready(shown.value, true);
  }
  return incoming;
};

const queryOf = (acquired: Acquired): Effect.Effect<QueryEntry<unknown, QueryFailure>> => {
  if (acquired.resource._tag === "Query") {
    return Effect.succeed(acquired.resource.entry);
  }
  return Effect.die(`declaration ${acquired.key} changed from a query to an actor`);
};

const addressOf = (acquired: Acquired): Option.Option<Addressed> => {
  if (acquired.resource._tag === "Query") {
    return Option.none();
  }
  return Option.some(acquired.resource);
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
  // The one step that moves the shown state: the current entry's state now,
  // carried over the state shown last. A read and a delivery both take it,
  // so a read never runs ahead of `changes` and a late delivery never
  // undoes a newer value (#22; see `advance`).
  const step = (shown: QueryState<unknown, QueryFailure>) =>
    Effect.map(currentEntry.state.get, (state) => carry(shown, state));
  const followEntry = (next: QueryEntry<unknown, QueryFailure>, scope: Scope.Scope) =>
    Effect.forkIn(
      Stream.runForEach(next.state.changes, () => advance(output, step)),
      scope,
    );
  yield* followEntry(entry, follow);
  const exposed: FollowedQuery<unknown, QueryFailure> = {
    // A readiness boundary may read a held settle ahead (`read-ahead.ts`).
    state: holding(
      { get: advance(output, step), changes: advancedChanges(output, step) },
      Effect.suspend(() => heldOf(currentEntry.state)),
    ),
    refresh: Effect.suspend(() => currentEntry.refresh),
    // The entry the binding names at the call: after a transition moved it,
    // an override reads and writes the new entry, never the one that exited,
    // and never derives from the exited entry's value the binding still shows.
    override: (update) => Effect.suspend(() => currentEntry.override(update)),
  };
  const binding: Binding = {
    current: () => current,
    exposed,
    install: (next) =>
      Effect.gen(function* () {
        const nextEntry = yield* queryOf(next);
        currentEntry = nextEntry;
        yield* Scope.close(follow, Exit.void);
        follow = yield* Scope.fork(owner);
        yield* advance(output, step);
        yield* followEntry(nextEntry, follow);
        const replaced = current;
        current = next;
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
  const ref: Source<RemoteActorRef<AnyContract>> = Source.mapEffect(state, (value) =>
    Effect.flatMap(addressIn(value, name), (held) => {
      if (held._tag === "Actor") {
        return Effect.succeed(held.ref);
      }
      return Effect.die(`actor binding ${name} holds a send-only reference`);
    }),
  );
  const exposed: FollowedActor<AnyContract> = {
    ref,
    state: Source.switchMap(ref, (held) => held.state),
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

/**
 * A send-only binding: like an actor binding, its reference lives in the
 * instance state beside its params, so a control reads a consistent pair.
 */
const commandsBinding = (
  name: string,
  first: Acquired,
  state: Source<InstanceState<unknown, unknown>>,
): Binding => {
  let current = first;
  const exposed: FollowedCommands<AnyContract> = {
    ref: Source.mapEffect(state, (value) => Effect.map(addressIn(value, name), (held) => held.ref)),
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

/** Values and actor addresses, published together so a control sees a consistent pair. */
interface InstanceState<Params, Search> {
  readonly values: Values<Params, Search>;
  readonly refs: ReadonlyMap<string, Addressed>;
}

const addressIn = (
  state: InstanceState<unknown, unknown>,
  name: string,
): Effect.Effect<Addressed> =>
  Option.match(Option.fromNullishOr(state.refs.get(name)), {
    onNone: () => Effect.die(`actor binding ${name} has no ref`),
    onSome: Effect.succeed,
  });

const refsOf = (bindings: ReadonlyMap<string, Binding>): ReadonlyMap<string, Addressed> =>
  new Map(
    Array.from(bindings).flatMap(([name, binding]) =>
      Option.match(addressOf(binding.current()), {
        onNone: () => [],
        onSome: (held): ReadonlyArray<readonly [string, Addressed]> => [[name, held]],
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The branch runtime
// ---------------------------------------------------------------------------

/** Where one child instance is shown: a layout's outlet. */
interface Slot<R> {
  readonly data: DataRecord;
  readonly childrenScope: Scope.Scope;
  readonly outlet: SubscriptionRef.SubscriptionRef<ReadonlyArray<Instance<R>>>;
  child: Option.Option<Instance<R>>;
}

interface Internals<Params, Search, ChildR> extends Slot<ChildR> {
  readonly state: SubscriptionRef.SubscriptionRef<InstanceState<Params, Search>>;
  readonly bindings: ReadonlyMap<string, Binding>;
  signature: string;
  failed: boolean;
}

/**
 * The outlet's setup: a keyed list of at most one instance.
 *
 * The instance the outlet holds when the layout yields it is set up here,
 * in the layout's setup, and its row takes that node. So the first frame
 * holds it, as it holds the root: its `ready` reads register with a
 * `Loading` around the outlet while that `Loading` sets up, and a settled
 * branch draws its content on the first frame, on the server and in
 * hydration alike. A list row sets up after the frame, so the `Loading`
 * would show its fallback first. A later instance comes through the list,
 * and so does one that presents `pending`: its timing starts when the
 * parent is drawn, not when the parent's setup yields the outlet. Each
 * setup runs in the instance's own view Scope, wherever it is yielded.
 */
const slotSetup = <R>(slot: Slot<R>): Effect.Effect<Node, never, R> =>
  Effect.gen(function* () {
    const held = new Map<string, Node>();
    for (const instance of yield* SubscriptionRef.get(slot.outlet)) {
      if (!instance.presents) {
        held.set(instance.key, yield* instance.setup);
      }
    }
    return yield* View.list({
      each: Source.fromSubscriptionRef(slot.outlet),
      keyBy: (instance) => instance.key,
      row: (item) =>
        Effect.flatMap(item.get, (instance) =>
          Option.match(Option.fromNullishOr(held.get(instance.key)), {
            onNone: () => instance.setup,
            onSome: (node) => {
              // Taken once: the same key again is a new row, set up again.
              held.delete(instance.key);
              return Effect.succeed(node);
            },
          }),
        ),
    });
  });

/**
 * Plan one slot. A failed instance is never stayed: any navigation that
 * reaches it is a new attempt, so it is entered again.
 */
const prepareSlot = <R>(
  tree: TreeState,
  input: Option.Option<Match<R>>,
  current: Option.Option<Instance<R>>,
): Effect.Effect<ChildPlan<R>, TransportReadError> =>
  Option.match(input, {
    onNone: () => Effect.succeed<ChildPlan<R>>({ _tag: "None" }),
    onSome: (matched): Effect.Effect<ChildPlan<R>, TransportReadError> => {
      if (
        Option.isSome(current) &&
        current.value.branch === matched.branch &&
        !current.value.failed()
      ) {
        return matched.stay(current.value, tree);
      }
      return Effect.map(matched.enter(tree), (entering): ChildPlan<R> => ({
        _tag: "Enter",
        entering,
      }));
    },
  });

const abortPlan = <R>(plan: ChildPlan<R>): Effect.Effect<void> => {
  if (plan._tag === "Stay") {
    return plan.staying.abort;
  }
  if (plan._tag === "Enter") {
    return plan.entering.abort;
  }
  return Effect.void;
};

/** Commit one slot: stay in place, or swap the outlet item, then exit the old one. */
const commitSlot = Effect.fn("Branch.commitSlot")(function* <R>(slot: Slot<R>, plan: ChildPlan<R>) {
  if (plan._tag === "Stay") {
    return yield* plan.staying.commit;
  }
  const exited = slot.child;
  let next = Option.none<Instance<R>>();
  if (plan._tag === "Enter") {
    next = Option.some(yield* plan.entering.create(slot.data, slot.childrenScope));
  }
  slot.child = next;
  yield* SubscriptionRef.set(slot.outlet, Option.toArray(next));
  if (Option.isSome(exited)) {
    // The exited view closes first. Its interests are released after it.
    yield* exited.value.close;
    yield* exited.value.release;
  }
});

/** What a pending presentation draws: nothing yet, the fallback, or the view. */
interface Shown {
  readonly key: "fallback" | "view";
  readonly node: Node;
}

/**
 * The completed work, or None when `deadline` came first. A result that is
 * already there wins over a deadline that has already passed.
 */
const awaitUntil = <A>(
  fiber: Fiber.Fiber<A>,
  deadline: number,
): Effect.Effect<Option.Option<Exit.Exit<A>>> =>
  Effect.gen(function* () {
    const polled = Option.fromNullishOr(fiber.pollUnsafe());
    const now = yield* Clock.currentTimeMillis;
    if (Option.isSome(polled) || now >= deadline) {
      return polled;
    }
    return yield* Effect.timeoutOption(Fiber.await(fiber), Duration.millis(deadline - now));
  });

const sleepUntil = (deadline: number): Effect.Effect<void> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => {
    if (now >= deadline) {
      return Effect.void;
    }
    return Effect.sleep(Duration.millis(deadline - now));
  });

/**
 * Present one instance's preparation. With no `pending` the setup runs in
 * place, as before. With one, the setup runs on a fiber owned by the view
 * Scope and this returns at once:
 *
 * - The fallback shows at `begin + after`, unless the setup already
 *   finished. `begin` is the later of `startedAt` (when the transition
 *   entered the segment) and the Clock when this presentation starts. It
 *   can start much later: after a slow declared acquisition, or when a
 *   slow or lazy parent finally draws the outlet.
 * - Once shown, a successful setup is drawn at `shown + atLeast` at the
 *   earliest, where `shown` is the Clock read just after the fallback was
 *   set. A typed failure's `errored` node is drawn at once.
 * - A defect removes the fallback at once and fails the presenting fiber.
 * - Closing the view Scope interrupts both fibers: nothing waits for
 *   `atLeast`, and nothing late is drawn.
 *
 * While it prepares, the region registers nothing with the nearest
 * `Loading`, so that Loading presents this fallback rather than its own,
 * unless a read the setup made before it suspended is still unsettled.
 */
const presentWith = <R>(
  pending: Option.Option<Timed>,
  work: Effect.Effect<Node, never, R>,
  startedAt: number,
  failed: () => boolean,
  drawn: Deferred.Deferred<boolean>,
): Effect.Effect<Node, never, R | Scope.Scope> =>
  Option.match(pending, {
    onNone: () =>
      Effect.onExit(work, (exit) => Deferred.succeed(drawn, Exit.isSuccess(exit) && !failed())),
    onSome: (options): Effect.Effect<Node, never, R | Scope.Scope> =>
      Effect.gen(function* () {
        const owner = yield* Effect.scope;
        const shown = yield* SubscriptionRef.make<ReadonlyArray<Shown>>([]);
        const fiber = yield* Effect.forkIn(work, owner);
        const finish = (exit: Exit.Exit<Node>) =>
          Exit.match(exit, {
            onSuccess: (node) =>
              Effect.andThen(
                SubscriptionRef.set(shown, [{ key: "view", node }]),
                Deferred.succeed(drawn, !failed()),
              ),
            onFailure: (cause) =>
              Effect.andThen(SubscriptionRef.set(shown, []), Effect.failCause(cause)),
          });
        // Read here, in setup, so the deadline does not wait for the fiber.
        const begin = Math.max(startedAt, yield* Clock.currentTimeMillis);
        const showAt = begin + Duration.toMillis(options.after);
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const early = yield* awaitUntil(fiber, showAt);
            if (Option.isSome(early)) {
              return yield* finish(early.value);
            }
            yield* SubscriptionRef.set(shown, [{ key: "fallback", node: options.fallback }]);
            // The fallback is this instance's shell: nothing below it draws yet.
            yield* Deferred.succeed(drawn, false);
            const holdUntil = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.atLeast);
            const exit = yield* Fiber.await(fiber);
            if (Exit.isSuccess(exit) && !failed()) {
              yield* sleepUntil(holdUntil);
            }
            return yield* finish(exit);
          }).pipe(
            // A defect or a close never leaves the shell waiting.
            Effect.onExit(() => Deferred.succeed(drawn, false)),
          ),
          owner,
        );
        return yield* View.list({
          each: Source.fromSubscriptionRef(shown),
          keyBy: (one) => one.key,
          row: (item) => Effect.map(item.get, (one) => one.node),
        });
      }),
  });

/**
 * An instance that shows only `errored`: its own declarations failed. It
 * holds no binding and no child, and it is always entered again.
 */
const failedEntering = <R>(
  tree: TreeState,
  name: string,
  identity: BranchIdentity,
  values: Values<unknown, unknown>,
  node: () => Node,
  behavior: Option.Option<NavigationBehavior>,
): Entering<R> => ({
  abort: Effect.void,
  create: (_inherited, parentScope) =>
    Effect.map(Scope.fork(parentScope), (scope): Instance<R> => ({
      key: tree.nextKey(name),
      branch: identity,
      setup: Scope.provide(
        attempt(Effect.sync(node), (error: never): Effect.Effect<Node> => Function.absurd(error)),
        scope,
      ),
      presents: false,
      close: Scope.close(scope, Exit.void),
      release: Effect.void,
      values: Effect.succeed(values),
      child: Effect.succeed(Option.none()),
      failed: () => true,
      behavior,
      // Its errored node is not the leaf's view: focus has no root to reach.
      root: Effect.succeed(Option.none()),
      // It has no outlet: nothing below it draws.
      drawn: Effect.succeed(false),
      // It holds no binding: nothing is left to read.
      settled: Effect.void,
      // Its view never ran, so nothing registered a check.
      questions: () => Effect.succeed([]),
    })),
});

/** Which prepared part failed: this segment's own declaration, or a descendant. */
type PartFailure =
  | { readonly _tag: "Own"; readonly error: TransportReadError }
  | { readonly _tag: "Descendant"; readonly error: TransportReadError };

const ownPart = <A>(effect: Effect.Effect<A, TransportReadError>) =>
  Effect.mapError(effect, (error): PartFailure => ({ _tag: "Own", error }));

const descendantPart = <A>(effect: Effect.Effect<A, TransportReadError>) =>
  Effect.mapError(effect, (error): PartFailure => ({ _tag: "Descendant", error }));

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
  // oxlint-disable-next-line effect/noAs -- assemble builds exactly one binding per declared name, inherited first.
  return fields as RouteData<Data>;
};

/** The outline node of `branch` in a matched outline, when it matched. */
const outlineAt = (from: Option.Option<Outline>, branch: BranchIdentity): Option.Option<Outline> =>
  Option.flatMap(from, (node) => {
    if (node.branch === branch) {
      return Option.some(node);
    }
    return outlineAt(node.child, branch);
  });

const makeBranch = <
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  CheckR,
  E,
  R,
  ChildR,
  ViewR,
  Root extends boolean = boolean,
>(
  seg: Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  children: ReadonlyArray<AnyBranch<ChildR>>,
  view: (
    props: SegmentProps<Params, Search, Data>,
    outlet: Effect.Effect<Node, never, ChildR>,
  ) => Effect.Effect<Node, E, R>,
  boundary: Boundary<E>,
  lazy: Option.Option<LazyDefinition>,
  behavior: Option.Option<NavigationBehavior>,
  driven: Option.Option<ErasedDriven>,
): Branch<Segment<Name, Params, Search, Own, Data, CheckR, Root>, ViewR, never> => {
  // A leaf's own view has the root focus moves to; a layout never claims it.
  const isLeaf = children.length === 0;
  // Typed memory of the instances this branch created. A match of this
  // branch reads it back, so no instance value is ever cast.
  const created = new WeakMap<Instance<unknown>, Internals<Params, Search, ChildR>>();
  const identity: BranchIdentity = { segment: seg.name };
  const segRuntime = segmentRuntimeOf(seg);

  const childRuntimes = children.map(runtimeOf);
  const matchChild = (input: MatchInput): Option.Option<Match<ChildR>> => {
    for (const runtime of childRuntimes) {
      const matched = runtime.match(input);
      if (Option.isSome(matched)) {
        return matched;
      }
    }
    return Option.none();
  };

  /**
   * A typed setup failure. Under the tree lock, the instance is marked
   * failed and its descendants and its own interests are released: the
   * errored node reads none of them, and the next navigation enters it
   * again. Only then is `errored` built. Without a handler `E` is `never`.
   */
  const setupFailed = (
    tree: TreeState,
    internals: Internals<Params, Search, ChildR>,
    error: E,
  ): Effect.Effect<Node, never, Scope.Scope> =>
    Option.match(boundary.errored, {
      onNone: () => Effect.die(error),
      onSome: (errored) =>
        Effect.andThen(
          tree.lock.withPermit(
            Effect.gen(function* () {
              internals.failed = true;
              const exited = internals.child;
              internals.child = Option.none();
              yield* SubscriptionRef.set(internals.outlet, []);
              if (Option.isSome(exited)) {
                yield* exited.value.close;
                yield* exited.value.release;
              }
              yield* releaseAll(
                Array.from(internals.bindings.values(), (binding) => binding.current()),
              );
            }),
          ),
          Effect.sync(() =>
            boundary.setupShell(errored(Source.succeed<RouteFailure<E>>({ _tag: "Setup", error }))),
          ),
        ),
    });

  /**
   * An own acquisition failure goes to `errored` when there is a handler and
   * the failure is not a refusal. A descendant's failure is not this
   * segment's to handle.
   */
  const declarationFailed = <A>(
    tree: TreeState,
    values: Values<Params, Search>,
    failure: PartFailure,
  ): Effect.Effect<Entering<A>, TransportReadError> => {
    const error = failure.error;
    if (
      failure._tag === "Own" &&
      error._tag !== "Unauthorized" &&
      Option.isSome(boundary.errored)
    ) {
      const errored = boundary.errored.value;
      return Effect.succeed(
        failedEntering<A>(
          tree,
          seg.name,
          identity,
          values,
          () => errored(Source.succeed<RouteFailure<E>>({ _tag: "Declaration", error })),
          behavior,
        ),
      );
    }
    return Effect.fail(error);
  };

  const create = Effect.fn("Branch.create")(function* (
    tree: TreeState,
    values: Values<Params, Search>,
    signature: string,
    acquired: ReadonlyArray<{ readonly name: string; readonly acquired: Acquired }>,
    childEntering: Option.Option<Entering<ChildR>>,
    ticket: Option.Option<Ticket>,
    startedAt: number,
    inherited: DataRecord,
    parentScope: Scope.Scope,
  ) {
    const presentable = tree.present;
    const scope = yield* Scope.fork(parentScope);
    const bindingsScope = yield* Scope.fork(scope);
    const viewScope = yield* Scope.fork(scope);
    const childrenScope = yield* Scope.fork(scope);
    const state = yield* SubscriptionRef.make<InstanceState<Params, Search>>({
      values,
      refs: new Map(),
    });
    const stateSource: Source<InstanceState<Params, Search>> = Source.fromSubscriptionRef(state);
    const bindings = new Map<string, Binding>();
    for (const one of acquired) {
      if (one.acquired.resource._tag === "Query") {
        bindings.set(one.name, yield* queryBinding(one.acquired, bindingsScope));
      } else if (one.acquired.resource._tag === "Commands") {
        bindings.set(one.name, commandsBinding(one.name, one.acquired, stateSource));
      } else {
        bindings.set(one.name, actorBinding(one.name, one.acquired, stateSource));
      }
    }
    yield* SubscriptionRef.set(state, { values, refs: refsOf(bindings) });
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
      failed: false,
    };
    /**
     * A search update of this segment against the latest URL. The router
     * refuses it once this route instance is gone. A URL where this branch
     * no longer matches is left as it is.
     */
    const moveSearch =
      (move: RouteNavigation["push"]) =>
      (update: SearchUpdater<Search>): Effect.Effect<void> =>
        move(
          (latest) =>
            Option.match(
              Option.flatMap(outlineAt(tree.outline(latest), identity), (outline) =>
                Option.map(
                  segRuntime.decode(outline.record, readSearch(latest.searchParams)),
                  (current) =>
                    segRuntime.searchUpdate(
                      latest,
                      { params: current.params, search: update(current.search) },
                      Option.isNone(outline.child),
                    ),
                ),
              ),
              { onNone: () => latest.href, onSome: Function.identity },
            ),
          tree.instance,
        );
    const props: SegmentProps<Params, Search, Data> = {
      href: (params, search) => seg.href(params, search),
      pushSearch: moveSearch(tree.navigation.push),
      replaceSearch: moveSearch(tree.navigation.replace),
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
    // The leave checks this instance's view registered, oldest first.
    const leaves: Array<LeaveEntry> = [];
    const mountedRoute: MountedRouteService = {
      owner: seg,
      register: (entry) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            leaves.push(entry);
          }),
          () =>
            Effect.sync(() => {
              const at = leaves.indexOf(entry);
              if (at >= 0) {
                leaves.splice(at, 1);
              }
            }),
        ),
    };
    const questions = (
      next: Option.Option<Outline>,
      destination: URL,
      kind: LeaveKind,
    ): Effect.Effect<ReadonlyArray<Question>> =>
      Effect.gen(function* () {
        // The candidate keeps this instance when the same branch matches here
        // and the instance has not failed: exactly when `prepareSlot` stays.
        const kept = Option.filter(
          next,
          (outline) => outline.branch === identity && !internals.failed,
        );
        const below = yield* Option.match(internals.child, {
          onNone: () => Effect.succeed<ReadonlyArray<Question>>([]),
          onSome: (current) =>
            current.questions(
              Option.flatMap(kept, (outline) => outline.child),
              destination,
              kind,
            ),
        });
        const unchanged = Option.exists(
          kept,
          (outline) => outline.signature === internals.signature,
        );
        if (unchanged || leaves.length === 0) {
          return below;
        }
        const current = yield* SubscriptionRef.get(state);
        const input: LeaveInput<unknown, unknown> = {
          previous: current.values,
          next: Option.map(kept, (outline) => outline.values),
          destination,
          kind,
        };
        // Deepest first: descendants, then this instance's newest check.
        const own = leaves.toReversed().map(
          (entry): Question =>
            (router) =>
              entry.ask(input, router),
        );
        return [...below, ...own];
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
    const rootCell = LeafRoot.makeCell();
    const drawnSignal = Deferred.makeUnsafe<boolean>();
    const drawn = (node: Node): Node => {
      if (isLeaf) {
        return LeafRoot.mark(node, rootCell);
      }
      return node;
    };
    const instance: Instance<ViewServices<R>> = {
      key: tree.nextKey(seg.name),
      branch: identity,
      // The view runs under an owned attempt in the instance's view Scope:
      // a row that starts after the instance closed never runs it, and a
      // typed failure closes the failed setup before `errored` is built. A
      // lazy view waits on the import attempt its transition took.
      setup: Scope.provide(
        presentWith(
          Option.filter(boundary.pending, () => presentable),
          attempt(
            Effect.suspend(() =>
              withTicket(
                ticket,
                Effect.map(
                  Effect.provideService(
                    view(props, slotSetup(internals)),
                    MountedRoute,
                    mountedRoute,
                  ),
                  drawn,
                ),
              ),
            ),
            (error: E) => setupFailed(tree, internals, error),
          ),
          startedAt,
          () => internals.failed,
          drawnSignal,
        ),
        viewScope,
      ),
      presents: Option.isSome(boundary.pending) && presentable,
      close: Scope.close(scope, Exit.void),
      release,
      values: Effect.map(SubscriptionRef.get(state), (current) => current.values),
      child: Effect.sync(() => internals.child),
      failed: () => internals.failed,
      behavior,
      root: Ref.get(rootCell),
      drawn: Deferred.await(drawnSignal),
      settled: Effect.suspend(() =>
        Effect.forEach(internals.bindings.values(), (binding) => settledRead(binding.current()), {
          concurrency: Math.max(internals.bindings.size, 1),
          discard: true,
        }),
      ),
      questions,
    };
    created.set(instance, internals);
    return instance;
  });

  const stayWith = Effect.fn("Branch.stay")(function* (
    tree: TreeState,
    internals: Internals<Params, Search, ChildR>,
    values: Values<Params, Search>,
    signature: string,
    childMatch: Option.Option<Match<ChildR>>,
  ) {
    const ownDeclarations = yield* keyed(segRuntime.declare(values));
    const names = new Set(ownDeclarations.map((one) => one.name));
    if (
      names.size !== internals.bindings.size ||
      ownDeclarations.some((one) => !internals.bindings.has(one.name))
    ) {
      return yield* Effect.die(`segment ${seg.name} changed its declaration names`);
    }
    const moves = ownDeclarations.filter((one) =>
      Option.exists(
        Option.fromNullishOr(internals.bindings.get(one.name)),
        (binding) => binding.current().key !== one.key,
      ),
    );
    type Prepared =
      | { readonly _tag: "Own"; readonly name: string; readonly acquired: Acquired }
      | { readonly _tag: "Child"; readonly plan: ChildPlan<ChildR> };
    const outcome = yield* Effect.result(
      allOrNothing<Prepared, PartFailure>(
        [
          ...moves.map((one) =>
            Effect.map(ownPart(acquire(tree, one.key, one.declaration)), (acquired): Prepared => ({
              _tag: "Own",
              name: one.name,
              acquired,
            })),
          ),
          Effect.map(
            descendantPart(prepareSlot(tree, childMatch, internals.child)),
            (plan): Prepared => ({ _tag: "Child", plan }),
          ),
        ],
        (part) => {
          if (part._tag === "Own") {
            return Scope.close(part.acquired.scope, Exit.void);
          }
          return abortPlan(part.plan);
        },
      ),
    );
    if (Result.isFailure(outcome)) {
      // A handled own failure replaces this instance with a failed one.
      const entering = yield* declarationFailed<ViewServices<R>>(tree, values, outcome.failure);
      const plan: Plan<ViewServices<R>> = { _tag: "Enter", entering };
      return plan;
    }
    const parts = outcome.success;
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
        abortPlan(childPlan),
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
            refs: refsOf(internals.bindings),
          });
        }
        yield* commitSlot(internals, childPlan);
        yield* releaseAll(replaced);
      }),
    };
    const plan: Plan<ViewServices<R>> = { _tag: "Stay", staying };
    return plan;
  });

  const enterWith = Effect.fn("Branch.enter")(function* (
    tree: TreeState,
    values: Values<Params, Search>,
    signature: string,
    childMatch: Option.Option<Match<ChildR>>,
  ) {
    // Every check continued before the transition entered this segment: the
    // pending timer and the import start here, not earlier.
    const startedAt = yield* Clock.currentTimeMillis;
    const ticket = yield* Effect.transposeOption(
      Option.map(lazy, (definition) => definition.start),
    );
    const ownDeclarations = yield* keyed(segRuntime.declare(values));
    type Prepared =
      | { readonly _tag: "Own"; readonly name: string; readonly acquired: Acquired }
      | { readonly _tag: "Child"; readonly entering: Entering<ChildR> };
    const childPart: ReadonlyArray<Effect.Effect<Prepared, PartFailure>> = Option.match(
      childMatch,
      {
        onNone: () => [],
        onSome: (matched) => [
          Effect.map(descendantPart(matched.enter(tree)), (entering): Prepared => ({
            _tag: "Child",
            entering,
          })),
        ],
      },
    );
    const outcome = yield* Effect.result(
      allOrNothing<Prepared, PartFailure>(
        [
          ...ownDeclarations.map((one) =>
            Effect.map(ownPart(acquire(tree, one.key, one.declaration)), (acquired): Prepared => ({
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
      ),
    );
    if (Result.isFailure(outcome)) {
      return yield* declarationFailed<ViewServices<R>>(tree, values, outcome.failure);
    }
    if (!tree.present && Option.isSome(ticket)) {
      // The first frame holds the imported view. The outcome is the setup's
      // to read: it waits on this same attempt, so a failure reaches
      // `errored` without a second import.
      yield* Effect.exit(Deferred.await(ticket.value.done));
    }
    const parts = outcome.success;
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
    const entering: Entering<ViewServices<R>> = {
      abort: Effect.andThen(
        releaseAll(acquired.map((part) => part.acquired)),
        Option.match(childEntering, {
          onNone: () => Effect.void,
          onSome: (next) => next.abort,
        }),
      ),
      create: (inherited, parentScope) =>
        create(
          tree,
          values,
          signature,
          acquired,
          childEntering,
          ticket,
          startedAt,
          inherited,
          parentScope,
        ),
    };
    return entering;
  });

  const lookup = (instance: Instance<unknown>) =>
    Option.match(Option.fromNullishOr(created.get(instance)), {
      onNone: () => Effect.die(`segment ${seg.name} did not create this instance`),
      onSome: (internals) => Effect.succeed(internals),
    });

  const match = (input: MatchInput): Option.Option<Match<ViewServices<R>>> =>
    Option.flatMap(matchPrefix(segRuntime.parts, input.segments, input.index), (prefix) => {
      const record: PathRecord = { ...input.record, ...prefix.record };
      return Option.flatMap(segRuntime.decode(record, input.search), (values) => {
        const signature = segRuntime.signature(record, values);
        const childMatch = matchChild({
          segments: input.segments,
          index: prefix.next,
          record,
          search: input.search,
        });
        if (Option.isNone(childMatch) && prefix.next !== input.segments.length) {
          return Option.none();
        }
        const matched: Match<ViewServices<R>> = {
          branch: identity,
          outline: {
            branch: identity,
            record,
            values,
            signature,
            child: Option.map(childMatch, (next) => next.outline),
          },
          // Parent first: a child is asked only after this segment continued.
          check: (url, kind) =>
            Effect.flatMap(
              Option.getOrElse(segRuntime.check(values, url, kind), () =>
                Effect.succeed<Verdict>(Continue),
              ),
              (verdict): Check => {
                if (verdict._tag === "Redirect") {
                  return Effect.succeed(verdict);
                }
                return Option.match(childMatch, {
                  onNone: () => Effect.succeed<Verdict>(Continue),
                  onSome: (next) => next.check(url, kind),
                });
              },
            ),
          enter: (tree) => enterWith(tree, values, signature, childMatch),
          stay: (instance, tree) =>
            Effect.flatMap(lookup(instance), (internals) =>
              stayWith(tree, internals, values, signature, childMatch),
            ),
        };
        return Option.some(matched);
      });
    });

  const made: Branch<Segment<Name, Params, Search, Own, Data, CheckR, Root>, ViewR, never> = {
    _tag: "Branch",
    [BranchBrand]: "Branch",
    segment: seg,
    "~view": phantom<ViewR>(),
    "~data": phantom<never>(),
  };
  const runtime: BranchRuntime<ViewServices<R>> = {
    match,
    searchKeys: [seg.searchKeys, ...childRuntimes.flatMap((below) => below.searchKeys)],
    segments: [seg, ...childRuntimes.flatMap((below) => below.segments)],
    level: {
      segment: seg,
      params: paramNames(segRuntime.parts),
      print: segRuntime.print,
      children: childRuntimes.map((below) => below.level),
    },
    leaves: leavesOf({ identity, driven }, childRuntimes),
  };
  runtimes.set(made, runtime);
  return made;
};

// ---------------------------------------------------------------------------
// The tree as one route
// ---------------------------------------------------------------------------

interface MountedTree<R> {
  readonly tree: TreeState;
  readonly root: Instance<R>;
}

const matchUrl = <R>(root: BranchRuntime<R>, url: URL): Option.Option<Match<R>> =>
  root.match({
    segments: segmentsOf(url.pathname),
    index: 0,
    record: {},
    search: readSearch(url.searchParams),
  });

/** The deepest instance of a mounted branch: the leaf the URL ends at. */
const deepestInstance = (instance: Instance<unknown>): Effect.Effect<Instance<unknown>> =>
  Effect.flatMap(instance.child, (next) =>
    Option.match(next, {
      onNone: () => Effect.succeed(instance),
      onSome: deepestInstance,
    }),
  );

/**
 * The branch's shell is drawn: each instance from the root down drew its
 * view, until the deepest, or until a pending fallback stands for the rest.
 */
const drawnFrom = (instance: Instance<unknown>): Effect.Effect<void> =>
  Effect.flatMap(instance.drawn, (drew) => {
    if (!drew) {
      return Effect.void;
    }
    return Effect.flatMap(instance.child, (next) =>
      Option.match(next, { onNone: () => Effect.void, onSome: drawnFrom }),
    );
  });

/**
 * The branch's declared reads have settled: each instance from the root
 * down, until the deepest or the first one that did not draw its view (a
 * pending fallback stands for the rest, and its reads are its own).
 */
const settledFrom = (instance: Instance<unknown>): Effect.Effect<void> =>
  Effect.andThen(
    instance.settled,
    Effect.flatMap(instance.drawn, (drew) => {
      if (!drew) {
        return Effect.void;
      }
      return Effect.flatMap(instance.child, (next) =>
        Option.match(next, { onNone: () => Effect.void, onSome: settledFrom }),
      );
    }),
  );

/** What the last commit offers the router: see `landing.ts`. */
const shellOf = (
  rootInstance: Instance<unknown>,
  deepestNow: Instance<unknown>,
  entered: boolean,
): Shell => ({
  entered,
  behavior: deepestNow.behavior,
  root: deepestNow.root,
  drawn: drawnFrom(rootInstance),
  settled: settledFrom(rootInstance),
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
 * Whether this tree is mounted by a navigation after the initial one. The
 * router provides `Router` to a route's setup and publishes the navigation
 * before it enters the route. Without a router, the mount is a first frame.
 */
const laterNavigation: Effect.Effect<boolean> = Effect.flatMap(
  Effect.serviceOption(Router),
  (router) =>
    Option.match(router, {
      onNone: () => Effect.succeed(false),
      onSome: (service) =>
        Effect.map(service.navigations.get, (navigation) => navigation.kind !== "initial"),
    }),
);

/**
 * Mount a tree as one route. `update` runs the nested transition for every
 * URL the tree matches. The router runs the tree's checks before it moves
 * history and before `enter` or `update`. An acquisition failure that no
 * segment handles is a defect: nothing is published. `extra` is copied onto
 * the route before its checks are registered under it.
 */
const mountTree = <Name extends string, ViewR, DataR, Extra extends object>(
  name: Name,
  branch: AnyBranch<ViewR>,
  extra: Extra,
  mode: RenderingMode,
): Extra & Tree<Name, ViewR | DataR> => {
  // A child segment matches only below its ancestors' path, so a tree
  // mounted from one would never match. The type refuses it; so does this.
  if (Option.isSome(branch.segment.parent)) {
    return Option.getOrThrowWith(Option.none(), () =>
      BranchRejected.make({
        segment: branch.segment.name,
        reason: "a tree is mounted from a root segment, not a child",
      }),
    );
  }
  const root = runtimeOf(branch);
  for (const held of root.segments) {
    const names = Option.getOrElse(
      Option.fromNullishOr(treesOf.get(held)),
      () => new Set<string>(),
    );
    names.add(name);
    treesOf.set(held, names);
  }
  const outline = (url: URL) => Option.map(matchUrl(root, url), (matched) => matched.outline);
  const mountable: Extra & Tree<Name, ViewR | DataR> = {
    ...extra,
    [RouteBrand]: mode,
    name,
    searchKeys: treeSearchKeys(root.searchKeys),
    enter: (url, navigation = unavailable) =>
      Option.map(matchUrl(root, url), (first) =>
        Effect.sync((): Entered<ViewR | DataR> => {
          let mounted = Option.none<MountedTree<ViewR>>();
          /** The last commit's shell. The first mount enters every segment. */
          let shell = Option.none<Shell>();
          let counter = 0;
          const routeInstance: RouteInstance = { _tag: "RouteInstance" };
          const entered: Entered<ViewR | DataR> = {
            instance: routeInstance,
            setup: Effect.gen(function* () {
              const owner = yield* Effect.scope;
              // Forked first, so it closes last: every view closes before
              // any declaration interest is released.
              const declarations = yield* Scope.fork(owner);
              const cache = yield* Effect.serviceOption(QueryCache);
              const tree: TreeState = {
                navigation,
                instance: routeInstance,
                outline,
                declarations,
                resolve: yield* ResolveBeforeRender,
                cache,
                transport: yield* Effect.serviceOption(ActorTransport),
                actors: yield* RcMap.make({ lookup: openSharedActor(yield* currentDocument) }).pipe(
                  Scope.provide(declarations),
                ),
                nextKey: (segmentName) => {
                  counter += 1;
                  return `${segmentName}#${String(counter)}`;
                },
                lock: yield* Semaphore.make(1),
                present: yield* laterNavigation,
              };
              const entering = yield* Effect.orDie(first.enter(tree));
              const instance = yield* entering.create(new Map(), owner);
              // Every instance of the first mount exists now. Later ones present.
              tree.present = true;
              mounted = Option.some({ tree, root: instance });
              shell = Option.some(shellOf(instance, yield* deepestInstance(instance), true));
              // Yielded directly, not through a list, so a host's first
              // frame holds the root's setup.
              return yield* instance.setup;
            }),
            update: (next) =>
              Option.match(Option.all([mounted, matchUrl(root, next)]), {
                onNone: () => Effect.succeed(false),
                // The root keeps one instance for this mount. When it must
                // be entered again (it failed, or its own move failed into
                // `errored`), the answer is false and the router enters the
                // whole tree again, before it closes this one.
                onSome: ([current, matched]) =>
                  current.tree.lock.withPermit(
                    Effect.gen(function* () {
                      if (current.root.failed()) {
                        return false;
                      }
                      const plan = yield* Effect.orDie(
                        prepareSlot(current.tree, Option.some(matched), Option.some(current.root)),
                      );
                      if (plan._tag !== "Stay") {
                        yield* abortPlan(plan);
                        return false;
                      }
                      // The leaf entered when the deepest instance is another one.
                      const before = yield* deepestInstance(current.root);
                      yield* plan.staying.commit;
                      const after = yield* deepestInstance(current.root);
                      shell = Option.some(shellOf(current.root, after, after !== before));
                      return true;
                    }),
                  ),
              }),
            inspection: Effect.suspend(() =>
              Option.match(mounted, {
                onNone: () => Effect.succeed({ params: {}, search: {} }),
                onSome: (current) => deepest(current.root),
              }),
            ),
            shell: Effect.suspend(() =>
              Option.match(shell, {
                onNone: () => Effect.die("the tree reported a shell before its first mount"),
                onSome: Effect.succeed,
              }),
            ),
            // Leave questions for a candidate: the mounted root answers for the
            // whole tree. A candidate of another route exits every instance.
            questions: (candidate: Candidate) =>
              Option.match(mounted, {
                onNone: () => Effect.succeed<ReadonlyArray<Question>>([]),
                onSome: (current) =>
                  current.root.questions(
                    Option.map(
                      Option.filter(matchUrl(root, candidate.destination), () => candidate.stays),
                      (matched) => matched.outline,
                    ),
                    candidate.destination,
                    candidate.kind,
                  ),
              }),
          };
          return entered;
        }),
      ),
  };
  // `DataR` lists every segment's `CheckR`: widening the erased checks to it
  // restores what they need, and the router runs them in the mount context.
  const checks: Checker<DataR> = (url, kind) =>
    Option.match(matchUrl(root, url), {
      onNone: () => Effect.succeed<Verdict>(Continue),
      onSome: (matched) => matched.check(url, kind),
    });
  registerChecks(mountable, checks);
  return mountable;
};

/** A mounted tree: an ordinary route for `mount({ routes })`. */
export interface Tree<Name extends string, R> extends AnyRoute<R> {
  readonly name: Name;
}

const unavailable: RouteNavigation = {
  push: () => Effect.die("route navigation is unavailable before router mount"),
  replace: () => Effect.die("route navigation is unavailable before router mount"),
};

/**
 * A tree's search ownership: the union of every segment's keys when all
 * are known. `UrlState` then cannot claim a key that any segment decodes.
 */
const treeSearchKeys = (all: ReadonlyArray<SearchKeyInfo>): SearchKeyInfo => {
  if (all.some((info) => !info.known)) {
    return { known: false, keys: [] };
  }
  return { known: true, keys: [...new Set(all.flatMap((info) => info.keys))] };
};

/**
 * A rendering-mode constructor (#18 §6): it makes a tree mountable and names
 * how the server renders its documents. Each mode is its own constructor,
 * and no route value carries a mode field, so the same segments, leaves,
 * and layouts mount under any mode, and one branch never mixes two.
 *
 * There is one form: a root segment's branch. A one-page route is
 * `Route.client(name, Route.leaf(Route.segment(name, { path, params }), view))`.
 *
 * The tree's view services are final here, so a tree that leaves a
 * readiness scope open does not compile (`ScopesClosed`): a `View.ready`
 * whose view no `View.loading` wraps, or a layout that yields its outlet
 * outside one.
 *
 * @example
 * ```ts
 * const Home = Route.segment("home", { path: "/" });
 * export const HomeRoute = Route.ssr("home", Route.leaf(Home, HomeView));
 * ```
 */
export interface ModeConstructor {
  <const Name extends string, Seg extends RootSegment, ViewR, DataR>(
    name: Name,
    root: Branch<Seg, ViewR, DataR> & ScopesClosed<ViewR>,
  ): Tree<Name, ViewR | DataR>;
}

const modeConstructor =
  (mode: RenderingMode): ModeConstructor =>
  <const Name extends string, Seg extends RootSegment, ViewR, DataR>(
    name: Name,
    root: Branch<Seg, ViewR, DataR> & ScopesClosed<ViewR>,
  ): Tree<Name, ViewR | DataR> =>
    mountTree(name, root, {}, mode);

/**
 * `ClientOnly` (#22, #62): the route renders on the client only. A server
 * document of it holds an empty mount element and reads nothing.
 */
export const client: ModeConstructor = modeConstructor("ClientOnly");

/**
 * `SSR` (#18 §3.3): a server document resolves every query the matched
 * branch declares, concurrently and before the render pass, then draws once
 * and seeds the settled values. The client hydrates with no read of them.
 */
export const ssr: ModeConstructor = modeConstructor("SSR");

/**
 * `Streamed` (#22): a server document writes the shell at once, with a
 * placeholder for every query the branch declared, then one patch per
 * query as it settles.
 */
export const streamed: ModeConstructor = modeConstructor("Streamed");

/**
 * `AwaitAll` (#22): a server document waits until its drawing waits for
 * nothing, the branch's declared queries and every view read included,
 * then writes one document and one seed.
 */
export const awaitAll: ModeConstructor = modeConstructor("AwaitAll");

/**
 * A route that only redirects: its segment's URLs always move to `to`'s
 * answer, before anything draws, on the server (a `303`) and in the
 * browser alike. It has no view and no rendering mode, because it never
 * renders. The segment's own `before` runs first, so a check that redirects
 * elsewhere still wins. A segment that declares data is refused by the
 * type: nothing would read it.
 *
 * @example
 * ```ts
 * const home = Route.segment("home", { path: "/" });
 * export const Home = Route.redirecting("home", home, () =>
 *   Effect.succeed(Route.redirect(lists, {}, {})),
 * );
 * ```
 */
export const redirecting = <const Name extends string, Params, Search, CheckR = never, R = never>(
  name: Name,
  seg: Segment<string, Params, Search, NoDeclarations, NoDeclarations, CheckR, true>,
  to: (next: BeforeInput<Params, Search>) => Effect.Effect<Redirect, never, R>,
): Tree<Name, CheckR | R> => {
  const branch = leaf(seg, () =>
    Effect.die(`Route.redirecting("${name}") drew its view; its check always redirects first`),
  );
  const runtime = runtimeOf(branch);
  const segRuntime = segmentRuntimeOf(seg);
  // Its mode is never read: a document settles the checks before it reads
  // one, and this route's checks never continue.
  const tree = mountTree<Name, never, CheckR | R, object>(name, branch, {}, "SSR");
  const checks: Checker<CheckR | R> = (url, kind) =>
    Option.match(matchUrl(runtime, url), {
      onNone: () => Effect.succeed<Verdict>(Continue),
      onSome: (matched) =>
        Effect.flatMap(matched.check(url, kind), (verdict): Effect.Effect<Verdict, never, R> => {
          if (verdict._tag === "Redirect") {
            return Effect.succeed(verdict);
          }
          return Option.match(
            segRuntime.decode(matched.outline.record, readSearch(url.searchParams)),
            {
              onNone: () => Effect.succeed<Verdict>(Continue),
              onSome: (values) => to({ ...values, url, kind }),
            },
          );
        }),
    });
  registerChecks(tree, checks);
  return tree;
};

/**
 * A driven leaf's view and props at one URL, and the actor that drives it.
 * The props are typed so that only this view takes them.
 */
export interface DrivenAt {
  readonly view: View.View<never, never, DrivenServices>;
  readonly props: never;
  readonly drive: Remote.Drive<AnyContract>;
}

/** Each driven tree's resolver: the driven leaf a URL ends at. */
const drivenTrees = new WeakMap<object, (url: URL) => Option.Option<DrivenAt>>();

/** The deepest segment a URL matched, and its values. */
const deepestOutline = (outline: Outline): Outline =>
  Option.match(outline.child, { onNone: () => outline, onSome: deepestOutline });

/**
 * Refuse a tree that has a leaf with a client view, then remember how to
 * find the driven leaf a URL ends at. A layout may be any view: it hydrates
 * as a page does, and only its leaves are drawn over the wire.
 */
const drivenTree = <R>(
  name: string,
  root: AnyBranch<R>,
): ((url: URL) => Option.Option<DrivenAt>) => {
  const runtime = runtimeOf(root);
  const options = new Map<BranchIdentity, ErasedDriven>();
  for (const below of runtime.leaves) {
    const found = below.driven;
    if (Option.isNone(found)) {
      return Option.getOrThrowWith(Option.none(), () =>
        BranchRejected.make({
          segment: below.identity.segment,
          reason: `Route.driven("${name}") draws every leaf over the op wire; this leaf's view is a client view, not a Route.drivenView`,
        }),
      );
    }
    options.set(below.identity, found.value);
  }
  return (url) =>
    Option.flatMap(matchUrl(runtime, url), (matched) => {
      const leafOutline = deepestOutline(matched.outline);
      // oxlint-disable-next-line effect/noAs -- the leaf's own segment decoded these params, so they are its driven view's Params.
      const params = leafOutline.values.params as never;
      return Option.map(
        Option.fromNullishOr(options.get(leafOutline.branch)),
        (leafOptions): DrivenAt => ({
          view: leafOptions.view,
          props: params,
          drive: leafOptions.drive(params),
        }),
      );
    });
};

/**
 * `Driven` (#18 §6, #22 §5): every leaf of the tree is a server-driven view,
 * made by `Route.drivenView`, and a leaf with any other view is refused at
 * definition with `BranchRejected`. A leaf's view gets its params and may
 * need only `DrivenServices`: a client-only view does not compile.
 *
 * Its documents are `Streamed`: a layout's queries stream through the record
 * channel, and each driven leaf is drawn in its container. The client's page
 * hands each container to the op wire once `hydrate` has seen the document
 * end, and never before. The server end of the wire opens `Driven.session` for
 * `drivenAt(routes, url)`.
 */
export const driven: ModeConstructor = <
  const Name extends string,
  Seg extends RootSegment,
  ViewR,
  DataR,
>(
  name: Name,
  root: Branch<Seg, ViewR, DataR> & ScopesClosed<ViewR>,
): Tree<Name, ViewR | DataR> => {
  // Checked before the tree is mounted: a refused tree registers nothing.
  const resolve = drivenTree(name, root);
  const tree = mountTree<Name, ViewR, DataR, object>(name, root, {}, "Streamed");
  drivenTrees.set(tree, resolve);
  return tree;
};

/**
 * The driven leaf `url` ends at, among `routes`: its view, its props, and
 * its drive, as `Driven.session` takes them. None when no driven route
 * matches the URL. The server end of the op wire calls it for each
 * connection; the view and the props are the ones the client draws.
 */
export const drivenAt = <R>(
  routes: ReadonlyArray<AnyRoute<R>>,
  url: URL,
): Option.Option<DrivenAt> => {
  for (const route of routes) {
    const found = Option.flatMap(Option.fromNullishOr(drivenTrees.get(route)), (resolve) =>
      resolve(url),
    );
    if (Option.isSome(found)) {
      return found;
    }
  }
  return Option.none();
};

/** A prerender tree's options: how each segment that adds a param is enumerated. */
export interface PrerenderOptions<I extends ReadonlyArray<AnyInputs>> {
  /**
   * One `Route.inputs` per segment that adds a param, and none for a
   * segment that adds none. A tree whose segments add no param gives `[]`.
   */
  readonly inputs: I;
}

/**
 * The prerender constructor (#23). It takes `inputs`, and a call without
 * them does not compile: a build must know every page.
 */
export interface PrerenderConstructor {
  <
    const Name extends string,
    Seg extends RootSegment,
    ViewR,
    DataR,
    const I extends ReadonlyArray<AnyInputs>,
  >(
    name: Name,
    root: Branch<Seg, ViewR, DataR> & ScopesClosed<ViewR>,
    options: PrerenderOptions<I>,
  ): Tree<Name, ViewR | DataR> & Prerendered<InputsError<I[number]>, InputsServices<I[number]>>;
}

/**
 * `Prerender` (#23): the build renders every page its inputs enumerate, at
 * the URL `href` prints, and writes it to a file served before the router.
 * A request with no file renders through the same pipeline. Its rendering
 * mode is `AwaitAll`: a file cannot stream. Every segment that adds a param
 * names its `Route.inputs`, or the constructor refuses the tree with
 * `PrerenderAncestorNotEnumerable`.
 */
export const prerender: PrerenderConstructor = <
  const Name extends string,
  Seg extends RootSegment,
  ViewR,
  DataR,
  const I extends ReadonlyArray<AnyInputs>,
>(
  name: Name,
  root: Branch<Seg, ViewR, DataR> & ScopesClosed<ViewR>,
  options: PrerenderOptions<I>,
): Tree<Name, ViewR | DataR> & Prerendered<InputsError<I[number]>, InputsServices<I[number]>> => {
  // Checked before the tree is mounted: a refused tree registers nothing.
  const plan = planFor(name, runtimeOf(root).level, options.inputs);
  const tree = mountTree<
    Name,
    ViewR,
    DataR,
    Prerendered<InputsError<I[number]>, InputsServices<I[number]>>
  >(name, root, prerendered(), "AwaitAll");
  registerPrerender(tree, plan);
  return tree;
};

/** How one segment enumerates its own params for a prerender tree. See `prerender`. */
export const inputs = makeInputs;
