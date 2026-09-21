import type { Source } from "effect-frame/actor";
import { Context, Effect, Option, Predicate, Scope } from "effect";
import type { ForNode, MatchNode, Node, ShowNode } from "./jsx-runtime.js";
import { Empty } from "./jsx-runtime.js";

/**
 * Control flow in JSX. Both take an explicit source, so a reader sees what
 * makes the branch or the list move. They only build a marker; the runtime
 * interprets it.
 */

export interface ForProps<Item> {
  readonly each: Source<ReadonlyArray<Item>>;
  readonly keyBy: (item: Item) => string;
  /** Each row receives a read-only source for its own keyed item. */
  readonly children: (item: Source<Item>) => Node;
}

export const For = <Item>(props: ForProps<Item>): ForNode<Item> => ({
  _tag: "For",
  each: props.each,
  keyBy: props.keyBy,
  setup: (item) => Effect.succeed(props.children(item)),
});

export interface ListOptions<Item, R> {
  readonly each: Source<ReadonlyArray<Item>>;
  readonly keyBy: (item: Item) => string;
  /**
   * One view per row, run in a scope of its own that closes when the row
   * leaves: a row may spawn actors, follow queries and add finalizers, as a
   * view's setup does. It cannot fail, because a row has no place to return
   * a failure to; handle errors inside it.
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
    // oxlint-disable-next-line effect/noAs
    const rows = setup as ForNode<Item>["setup"];
    return { _tag: "For", each: options.each, keyBy: options.keyBy, setup: rows };
  });

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
