import { Source } from "effect-frame/actor/client";
import { Context, Effect, Option, Predicate, Scope } from "effect";
import type { ForNode, MatchNode, Node, PortalNode, ShowNode } from "./jsx-runtime.js";
import { Empty } from "./jsx-runtime.js";
import type { PortalTarget } from "./portal-target.js";

/**
 * Control flow in a view. The tags `For`, `Show` and `Match` each take an
 * explicit source, so a reader sees what makes the list or the branch move;
 * `Portal` takes the target, made by the host, that it draws under. A tag only builds a marker,
 * and the runtime interprets it. `View.list`, `View.keyed`, `View.show` and
 * `View.match` are the Effect forms of a keyed list, a keyed region and a
 * branch: they run each row's or branch's setup as an Effect, which a tag
 * cannot.
 */

export interface ForProps<Item> {
  readonly each: Source<ReadonlyArray<Item>>;
  readonly keyBy: (item: Item) => string;
  /** Each row receives a read-only source for its own keyed item. */
  readonly children: (item: Source<Item>) => Node;
  /** Drawn while the list is empty, as `Show`'s `fallback` is while it hides. */
  readonly fallback?: Node;
}

export const For = <Item>(props: ForProps<Item>): ForNode<Item> => ({
  _tag: "For",
  each: props.each,
  keyBy: props.keyBy,
  setup: (item) => Effect.succeed(props.children(item)),
  fallback: Option.getOrElse(Option.fromNullishOr(props.fallback), () => Empty),
});

export interface ListOptions<Item, R> {
  readonly each: Source<ReadonlyArray<Item>>;
  readonly keyBy: (item: Item) => string;
  /**
   * One view per row, run in a scope of its own that closes when the row
   * leaves: a row may spawn actors, follow queries and add finalizers, as a
   * view's setup does. It cannot fail, because a row has no place to return
   * a failure to; handle errors inside it. A defect it dies with fails the
   * mount while the mount builds, and closes the mount's scope with that
   * defect after. The row's scope closing while the setup runs interrupts
   * it, which is not a defect.
   */
  readonly row: (item: Source<Item>) => Effect.Effect<Node, never, R | Scope.Scope>;
}

/**
 * A keyed list whose rows run a setup. It is an Effect rather than a JSX
 * element because a row's requirements must be met somewhere, and a JSX
 * tree carries no `R`: `list` captures the context it is yielded in and
 * runs each row's setup there, so the enclosing view's `R` names what the
 * rows need. `const rows = yield* View.list({...}); return <ul>{rows}</ul>`.
 */
export const list = <Item, R>(
  options: ListOptions<Item, R>,
): Effect.Effect<ForNode<Item>, never, Exclude<R, Scope.Scope>> =>
  Effect.map(Effect.context<Exclude<R, Scope.Scope>>(), (captured) => {
    // The row runs in its own scope, which the runtime provides; the parent's
    // scope must not travel with the rest of the context, or a row's
    // finalizers would outlive the row.
    const context = Context.omit(Scope.Scope)(captured);
    // Providing `Exclude<R, Scope>` to an effect that needs `R | Scope`
    // leaves `Scope`, which the checker cannot reduce for a generic `R`, so
    // the assertion states what the arithmetic already means.
    const setup = (item: Source<Item>) => Effect.provide(options.row(item), context);
    // oxlint-disable-next-line effect/noAs -- the row setup is the For node's setup with its context provided.
    const rows = setup as ForNode<Item>["setup"];
    return { _tag: "For", each: options.each, keyBy: options.keyBy, setup: rows, fallback: Empty };
  });

/**
 * A keyed region with one row. The row's setup runs once per key: a new
 * value under the same key reaches the row through its `item` source, and a
 * value with a new key closes the row's scope and runs the setup again.
 * Use it where a region must be built again for a new identity, such as a
 * form that prints its actor's address, while the view around it stays.
 *
 * ```ts
 * // `props.data.counter.ref` is the Source of the actor the route holds now.
 * const controls = yield* View.keyed(
 *   props.data.counter.ref,
 *   (ref) => ref.key.name,
 *   (ref) => Effect.flatMap(ref.get, (current) => Controls({ counter: current })),
 * );
 * return <section>{controls}</section>;
 * ```
 */
export const keyed = <Item, R>(
  source: Source<Item>,
  keyBy: (item: Item) => string,
  row: (item: Source<Item>) => Effect.Effect<Node, never, R | Scope.Scope>,
): Effect.Effect<ForNode<Item>, never, Exclude<R, Scope.Scope>> =>
  list({ each: Source.select(source, (item): ReadonlyArray<Item> => [item]), keyBy, row });

/** A region whose setup is an Effect, run in a scope its branch owns. */
type Setup<Value, Needs> = (
  value: Source<Value>,
) => Effect.Effect<Node, never, Needs | Scope.Scope>;

export interface ShowOptions<R> {
  readonly when: Source<boolean>;
  /** Run each time the branch is shown, in a scope that closes when it hides. */
  readonly content: Effect.Effect<Node, never, R | Scope.Scope>;
  /** Run each time the branch is hidden, in a scope of its own. Nothing is drawn without it. */
  readonly fallback?: Effect.Effect<Node, never, R | Scope.Scope>;
}

const branchKey = (shown: boolean): string => {
  if (shown) {
    return "shown";
  }
  return "hidden";
};

/**
 * The Effect form of `<Show>`: a branch whose content runs a setup. The
 * setup runs when the source turns `true` and its scope closes when it
 * turns `false`, so a hidden branch holds no actor, follows no query and
 * observes no source. `fallback` runs the other way round. Built on
 * `keyed`, keyed by whether the branch is shown.
 *
 * ```ts
 * const results = yield* View.show({
 *   when: Source.select(params, (p) => p.q.length > 0),
 *   content: Results({ params }),
 *   fallback: Effect.succeed(<p>type to search</p>),
 * });
 * return <section>{results}</section>;
 * ```
 */
export const show = <R>(
  options: ShowOptions<R>,
): Effect.Effect<ForNode<boolean>, never, Exclude<R, Scope.Scope>> => {
  const fallback = Option.getOrElse(
    Option.fromNullishOr(options.fallback),
    (): Effect.Effect<Node, never, R | Scope.Scope> => Effect.succeed(Empty),
  );
  return keyed(options.when, branchKey, (shown) =>
    Effect.flatMap(shown.get, (value) => {
      if (value) {
        return options.content;
      }
      return fallback;
    }),
  );
};

const tagOf = (value: Tagged): string => value._tag;

/**
 * One setup per tag, and every tag present, as `MatchCases` is for `<Match>`.
 * `Needs` bounds what a case may need; `View.match` reads what each one does.
 */
export type MatchSetups<Union extends Tagged, Needs> = {
  readonly [K in Union["_tag"]]: Setup<Extract<Union, { readonly _tag: K }>, Needs>;
};

/** What a table of setups needs: the union of each case's services. */
type SetupServices<Cases> = {
  readonly [K in keyof Cases]: Cases[K] extends (
    value: never,
  ) => Effect.Effect<Node, never, infer R>
    ? R
    : never;
}[keyof Cases];

/**
 * The Effect form of `<Match>`: one branch per tag of a union source, whose
 * case runs a setup. A new tag closes the old branch's scope and runs the
 * new case; a new value under the same tag reaches the case through its
 * source, and the setup does not run again. The table is exhaustive, as
 * `<Match>`'s is, and what its cases need is what the view that yields it
 * needs. Built on `keyed`, keyed by the tag.
 *
 * ```ts
 * const body = yield* View.match(pane, {
 *   Idle: () => Effect.succeed(<p>no query yet</p>),
 *   Asked: (asked) => Effect.flatMap(asked.get, (a) => Results({ q: a.q })),
 * });
 * ```
 */
export function match<A extends Tagged, Cases extends MatchSetups<A, unknown>>(
  on: Source<A>,
  cases: Cases,
): Effect.Effect<ForNode<A>, never, Exclude<SetupServices<Cases>, Scope.Scope>>;
export function match<A extends Tagged, R>(
  on: Source<A>,
  cases: MatchSetups<A, R>,
): Effect.Effect<ForNode<A>, never, Exclude<R, Scope.Scope>> {
  // A case is written for its own member; the key it runs under says which
  // member the row's source holds while it is shown, as `Match`'s table does.
  const table: Record<
    string,
    { bivariant(value: Source<A>): Effect.Effect<Node, never, R | Scope.Scope> }["bivariant"]
  > = cases;
  return keyed(on, tagOf, (item) =>
    Effect.flatMap(item.get, (value) =>
      Option.match(Option.fromNullishOr(table[value._tag]), {
        onNone: (): Effect.Effect<Node, never, R | Scope.Scope> => Effect.succeed(Empty),
        onSome: (run) => run(item),
      }),
    ),
  );
}

/** The plain form: a boolean source, shown while it is `true`. */
export interface ShowProps {
  readonly when: Source<boolean>;
  readonly children: Node;
  /** Drawn while the branch is not. */
  readonly fallback?: Node;
}

/**
 * The narrowing form: any source, shown while `is` holds. The children may
 * be a function of a source of the narrowed value; that source exists only
 * while the branch is shown, so reading it never means reading the other
 * case. `<Show when={hits} is={(xs) => xs.length > 0}>{(xs) => ...}</Show>`.
 */
export interface ShowWhenProps<A, B extends A> {
  readonly when: Source<A>;
  readonly is: (value: A) => value is B;
  readonly children: Node | ((value: Source<B>) => Node);
  readonly fallback?: Node;
}

/** `ShowWhenProps` with a plain boolean test: the value is not narrowed. */
export interface ShowIfProps<A> {
  readonly when: Source<A>;
  readonly is: (value: A) => boolean;
  readonly children: Node | ((value: Source<A>) => Node);
  readonly fallback?: Node;
}

const isTrue = (value: boolean): boolean => value;

export function Show(props: ShowProps): ShowNode<boolean>;
export function Show<A, B extends A>(props: ShowWhenProps<A, B>): ShowNode<A>;
export function Show<A>(props: ShowIfProps<A>): ShowNode<A>;
export function Show<A>(props: ShowProps | ShowIfProps<A>): ShowNode<A> | ShowNode<boolean> {
  const fallback = Option.getOrElse(Option.fromNullishOr(props.fallback), () => Empty);
  if ("is" in props) {
    const children = props.children;
    if (Predicate.isFunction(children)) {
      return { _tag: "Show", when: props.when, test: props.is, render: children, fallback };
    }
    return { _tag: "Show", when: props.when, test: props.is, render: () => children, fallback };
  }
  return {
    _tag: "Show",
    when: props.when,
    test: isTrue,
    render: () => props.children,
    fallback,
  };
}

/** A value with a `_tag`, the shape Effect's `Match.tagsExhaustive` folds. */
export interface Tagged {
  readonly _tag: string;
}

/**
 * A case's parameter is compared bivariantly, as a method's is, so a case
 * written for one member is a case the node can call with its one source
 * of the whole union: the key it was drawn under says which member that
 * source holds while the case is shown.
 */
type Case<Member> = { bivariant(value: Source<Member>): Node }["bivariant"];

/**
 * One case per tag, and every tag present: the table is exhaustive at the
 * type level, so a new member of the union is a compile error at each
 * `Match` over it. A case receives a source of its own member, which exists
 * only while that member holds, as a narrowing `Show` does.
 */
export type MatchCases<A extends Tagged> = {
  readonly [K in A["_tag"]]: Case<Extract<A, { readonly _tag: K }>>;
};

export interface MatchProps<A extends Tagged> {
  readonly on: Source<A>;
  readonly cases: MatchCases<A>;
}

/**
 * Exhaustive control over a source of a tagged union. The case table takes
 * the shape of Effect's `Match.tagsExhaustive`, so what an app writes for an
 * actor's state it writes for a view. One source is tracked, one branch is
 * drawn, and a change that keeps the tag updates that branch in place.
 * `<Match on={state} cases={{ Idle: () => ..., Running: (s) => ... }} />`.
 */
export const Match = <A extends Tagged>(props: MatchProps<A>): MatchNode<A> => {
  const table: Record<string, Case<A>> = props.cases;
  return {
    _tag: "Match",
    on: props.on,
    key: (value) => value._tag,
    render: (tag, value) => {
      const draw = Option.fromNullishOr(table[tag]);
      return Option.match(draw, { onNone: () => Empty, onSome: (found) => found(value) });
    },
  };
};

export interface PortalProps {
  /**
   * Where the children are drawn: a target the host module made, such as
   * `Dom.target(document.body)`. Only that host draws into it.
   */
  readonly into: PortalTarget;
  readonly children: Node;
}

/**
 * Draw children under another node: a dialog under `document.body`, a
 * toast under a region outside the view's own subtree. The children are
 * still the view's: they read its sources, run in its scope, and leave with
 * its branch or row. Only their place in the document differs.
 *
 * A host draws a Portal only into a target it made; the HTML and Remote
 * hosts make none, so a Portal in a server render is a defect,
 * `View.PortalTargetRefused`, not a region that silently draws nothing.
 */
export const Portal = (props: PortalProps): PortalNode => ({
  _tag: "Portal",
  into: props.into,
  children: props.children,
});
