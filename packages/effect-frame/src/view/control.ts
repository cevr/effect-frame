import type { Source } from "effect-frame/actor";
import { Option, Predicate } from "effect";
import type { ForNode, Node, ShowNode } from "./jsx-runtime.js";
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
  render: props.children,
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
