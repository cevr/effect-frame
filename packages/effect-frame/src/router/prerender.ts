import { Effect, Option, Schema } from "effect";
import type { AnyRoute } from "./codec.js";
import type { AnySegment, Declarations, Segment } from "./branch.js";

/**
 * Prerender inputs (#23 §1, #86). A prerender tree names how every segment
 * that adds a path param is enumerated, and the build prints each page's
 * URL with the same `href` every link uses. See `docs/design/prerender.md`.
 *
 * This module is client-safe: a route tree is shared by the server, the
 * client, and the build, so the constructor and its registry live here.
 * The build itself is `prerender.server.ts`.
 */

declare const ParamsBrand: unique symbol;

/**
 * A decoded params record, with its segment types erased: what one level
 * of the enumeration hands the next. Only a segment's `print` reads it, and
 * it checks the record against its own params Schema first.
 */
export interface ParamsRecord {
  readonly [ParamsBrand]: "ParamsRecord";
}

/** The params of the tree's root level: none inherited. */
// oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- the empty record is the params nothing contributes.
const noParams = {} as ParamsRecord;

/** A level's params: its parent's, with its own added. */
const merge = (inherited: ParamsRecord, own: ParamsRecord): ParamsRecord => ({
  ...inherited,
  ...own,
});

/** The params a segment adds to the ones its ancestors add. */
export type OwnParams<Params, Inherited> = Omit<Params, keyof Inherited>;

/**
 * How a segment's own params are enumerated: one Effect, or one Effect per
 * inherited params record. The first spelling is the constant function.
 */
export type Enumerate<Own, Inherited, E, R> =
  | Effect.Effect<ReadonlyArray<Own>, E, R>
  | ((inherited: Inherited) => Effect.Effect<ReadonlyArray<Own>, E, R>);

/** Brands an inputs value: only `Route.inputs` makes one. */
const InputsBrand: unique symbol = Symbol.for("effect-frame/router/Inputs");

/**
 * One segment's enumeration, as a prerender tree takes it. `E` and `R` are
 * what the build needs to run it; a route that is only mounted never runs
 * it, so they never reach the router's requirements.
 */
export interface Inputs<E, R> {
  readonly _tag: "Inputs";
  readonly [InputsBrand]: "Inputs";
  readonly segment: AnySegment;
  /** Phantom: what the enumeration fails with and needs. */
  readonly "~inputs": (_: never) => { readonly error: E; readonly services: R };
}

/** Any inputs value. */
export type AnyInputs = Inputs<unknown, unknown>;

export type InputsError<I> = I extends Inputs<infer E, unknown> ? E : never;
export type InputsServices<I> = I extends Inputs<unknown, infer R> ? R : never;

/**
 * An enumeration with its failure and services moved to the route's
 * phantom (`Prerendered`). `enumerate` narrows them back where the build,
 * which reads that phantom, runs it.
 */
// @effect-diagnostics anyUnknownInErrorContext:off
type Erased = (
  inherited: ParamsRecord,
) => Effect.Effect<ReadonlyArray<ParamsRecord>, unknown, unknown>;

/** One own params value as the record the next level inherits. */
const asRecord = <Own>(own: Own): ParamsRecord =>
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Route.inputs typed Own as this segment's own params, a record.
  own as ParamsRecord;

const erase = <Own, E, R>(
  effect: Effect.Effect<ReadonlyArray<Own>, E, R>,
): Effect.Effect<ReadonlyArray<ParamsRecord>, unknown, unknown> =>
  Effect.map(effect, (list) => list.map(asRecord));

// @effect-diagnostics unsafeEffectTypeAssertion:off
const restore = <E, R>(
  effect: Effect.Effect<ReadonlyArray<ParamsRecord>, unknown, unknown>,
): Effect.Effect<ReadonlyArray<ParamsRecord>, E, R> =>
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- the caller names the E and R of the tree's Prerendered phantom, which lists every inputs value's.
  effect as Effect.Effect<ReadonlyArray<ParamsRecord>, E, R>;
// @effect-diagnostics unsafeEffectTypeAssertion:error

/** An enumeration in either spelling, erased. */
const eraseEnumerate =
  <Own, Inherited, E, R>(enumerate: Enumerate<Own, Inherited, E, R>): Erased =>
  (inherited) => {
    if (Effect.isEffect(enumerate)) {
      return erase(enumerate);
    }
    // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- the build passes exactly the params this segment's ancestors enumerated, which is Inherited.
    return erase(enumerate(inherited as Inherited));
  };

/** Run an erased enumeration with the channels its tree's phantom names. */
const runErased =
  <E, R>(run: Erased) =>
  (inherited: ParamsRecord): Effect.Effect<ReadonlyArray<ParamsRecord>, E, R> =>
    restore<E, R>(run(inherited));
// @effect-diagnostics anyUnknownInErrorContext:error

const enumerations = new WeakMap<AnyInputs, Erased>();

const phantom =
  <A>() =>
  (value: never): A =>
    value;

/**
 * Name how `segment` enumerates the params it adds. The function receives
 * the params its ancestors enumerated, once per ancestor page, and returns
 * only its own: the build adds the inherited ones. A root segment takes the
 * plain Effect.
 */
export const inputs = <Params, Inherited, E = never, R = never>(
  segment: Segment<
    string,
    Params,
    unknown,
    Declarations,
    Declarations,
    unknown,
    boolean,
    Inherited
  >,
  enumerate: Enumerate<OwnParams<Params, Inherited>, Inherited, E, R>,
): Inputs<E, R> => {
  const made: Inputs<E, R> = {
    _tag: "Inputs",
    [InputsBrand]: "Inputs",
    segment,
    "~inputs": phantom(),
  };
  enumerations.set(made, eraseEnumerate(enumerate));
  return made;
};

// ---------------------------------------------------------------------------
// The tree a prerender constructor made
// ---------------------------------------------------------------------------

/**
 * A mounted prerender tree. The phantom carries what its inputs fail with
 * and need, so `Prerender.build` asks for them and `mount` does not.
 */
export interface Prerendered<E, R> {
  readonly "~prerender": (_: never) => { readonly error: E; readonly services: R };
}

export type PrerenderError<Route> = Route extends Prerendered<infer E, unknown> ? E : never;
export type PrerenderServices<Route> = Route extends Prerendered<unknown, infer R> ? R : never;

/** The phantom a prerender constructor copies onto its route. */
export const prerendered = <E, R>(): Prerendered<E, R> => ({ "~prerender": phantom() });

/**
 * One segment of a prerender tree as the build walks it: its own param
 * names, how it prints a page's URL, and its children. `branch.ts` builds it
 * from the branch runtimes; a leaf is a node without children.
 */
export interface Level {
  readonly segment: AnySegment;
  /** The names of the params this segment's own path adds. */
  readonly params: ReadonlyArray<string>;
  /** Print the URL of this segment for a full params record. None: not this segment's params. */
  readonly print: (params: ParamsRecord) => Option.Option<string>;
  readonly children: ReadonlyArray<Level>;
}

/** What the build reads from a prerender tree. */
export interface Plan {
  readonly name: string;
  readonly level: Level;
  readonly inputs: ReadonlyMap<AnySegment, AnyInputs>;
}

const plans = new WeakMap<object, Plan>();

/** The plan of a route a prerender constructor made. None: another mode. */
export const planOf = <R>(route: AnyRoute<R>): Option.Option<Plan> =>
  Option.fromNullishOr(plans.get(route));

// ---------------------------------------------------------------------------
// The definition-time check (#23 §1.2)
// ---------------------------------------------------------------------------

/**
 * A prerender leaf has an ancestor, or is itself a segment, that adds a
 * param and names no inputs. A build renders every page before any request,
 * so every param must be enumerable. `ancestor` is the first such segment
 * from the root, and `param` the first param it adds.
 */
export class PrerenderAncestorNotEnumerable extends Schema.TaggedError<PrerenderAncestorNotEnumerable>()(
  "PrerenderAncestorNotEnumerable",
  {
    route: Schema.String,
    leaf: Schema.String,
    ancestor: Schema.String,
    param: Schema.String,
  },
) {
  override get message(): string {
    return `route "${this.route}" is prerender, but segment "${this.ancestor}" above leaf "${this.leaf}" adds param \`${this.param}\` and names no inputs. Give "${this.ancestor}" a Route.inputs, or mount "${this.route}" with another mode.`;
  }
}

/** An inputs value the tree cannot use. */
export class PrerenderInputsRejected extends Schema.TaggedError<PrerenderInputsRejected>()(
  "PrerenderInputsRejected",
  {
    route: Schema.String,
    segment: Schema.String,
    reason: Schema.Literals(["not in the tree", "named twice"]),
  },
) {}

const everyNode = (level: Level): ReadonlyArray<Level> => [
  level,
  ...level.children.flatMap(everyNode),
];

const firstLeaf = (level: Level): Level =>
  Option.match(Option.fromNullishOr(level.children[0]), {
    onNone: () => level,
    onSome: firstLeaf,
  });

const refuse = (error: PrerenderAncestorNotEnumerable | PrerenderInputsRejected): never =>
  Option.getOrThrowWith(Option.none<never>(), () => error);

/**
 * Check a prerender tree and return its plan. Every segment that adds a
 * param must name inputs, and every inputs value must name a segment of
 * the tree, once. A segment that adds no param needs none: it contributes
 * one page per parent page. Given inputs, it contributes one per record,
 * so a flat route's inputs are its page list (`[{}]` is one page).
 * It runs where the tree is constructed, before the tree is mounted.
 */
export const planFor = (name: string, level: Level, given: ReadonlyArray<AnyInputs>): Plan => {
  const nodes = everyNode(level);
  const bySegment = new Map<AnySegment, AnyInputs>();
  for (const one of given) {
    if (!nodes.some((candidate) => candidate.segment === one.segment)) {
      return refuse(
        PrerenderInputsRejected.make({
          route: name,
          segment: one.segment.name,
          reason: "not in the tree",
        }),
      );
    }
    if (bySegment.has(one.segment)) {
      return refuse(
        PrerenderInputsRejected.make({
          route: name,
          segment: one.segment.name,
          reason: "named twice",
        }),
      );
    }
    bySegment.set(one.segment, one);
  }
  // Parent first, so the refusal names the segment nearest the root.
  for (const node of nodes) {
    const param = Option.fromNullishOr(node.params[0]);
    if (Option.isSome(param) && !bySegment.has(node.segment)) {
      return refuse(
        PrerenderAncestorNotEnumerable.make({
          route: name,
          leaf: firstLeaf(node).segment.name,
          ancestor: node.segment.name,
          param: param.value,
        }),
      );
    }
  }
  return { name, level, inputs: bySegment };
};

/** Record the plan of a route its prerender constructor made. */
export const register = <R>(route: AnyRoute<R>, plan: Plan): void => {
  plans.set(route, plan);
};

// ---------------------------------------------------------------------------
// Enumeration (#23 §1.2): the product down the branch, parent first
// ---------------------------------------------------------------------------

/** One page a prerender tree contributes: its route, its params, and its URL. */
export interface Page {
  readonly route: string;
  readonly params: ParamsRecord;
  readonly href: string;
}

/**
 * Every page of a plan. A child's inputs run once per parent params record,
 * with that record; a segment that adds no param passes its parent's
 * through. Only leaves are pages. Duplicates are the build's to collapse.
 */
export const enumerate = <E, R>(plan: Plan): Effect.Effect<ReadonlyArray<Page>, E, R> => {
  const own = (node: Level, inherited: ParamsRecord) =>
    Option.match(Option.fromNullishOr(plan.inputs.get(node.segment)), {
      onNone: () => Effect.succeed<ReadonlyArray<ParamsRecord>>([noParams]),
      onSome: (given) =>
        Option.match(Option.fromNullishOr(enumerations.get(given)), {
          onNone: () => Effect.die("an inputs value not made by Route.inputs"),
          onSome: (run) => runErased<E, R>(run)(inherited),
        }),
    });
  const walk = (node: Level, inherited: ParamsRecord): Effect.Effect<ReadonlyArray<Page>, E, R> =>
    Effect.flatMap(own(node, inherited), (records) =>
      Effect.map(
        Effect.forEach(records, (record) => {
          const params = merge(inherited, record);
          if (node.children.length === 0) {
            return Option.match(node.print(params), {
              onNone: () =>
                Effect.die(
                  `prerender inputs of "${plan.name}" gave params that segment "${node.segment.name}" cannot print`,
                ),
              onSome: (href) =>
                Effect.succeed<ReadonlyArray<Page>>([{ route: plan.name, params, href }]),
            });
          }
          return Effect.map(
            Effect.forEach(node.children, (child) => walk(child, params)),
            (pages) => pages.flat(),
          );
        }),
        (pages) => pages.flat(),
      ),
    );
  return walk(plan.level, noParams);
};
