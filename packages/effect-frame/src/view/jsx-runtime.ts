import type { Source } from "effect-frame/actor";
import type { Effect, Scope } from "effect";
import { Option, Predicate } from "effect";
import type { Attached, Bound, Prepared } from "./view.js";

/**
 * The JSX element model. A tree is data: the runtime walks it once at mount
 * and creates host nodes. Nothing here reads or writes a host.
 *
 * Every node carries a `_tag`, so the runtime narrows the tree by its tag and
 * never inspects a value's shape. `jsx` and `parse` are the one boundary
 * where a raw JSX expression becomes a tagged node.
 */

/** An intrinsic tag (`div`, `box`) or a component function. */
export type Tag = string | Component;

export type Component = (props: ElementProps) => Node;

/** A JSX value the runtime draws as text. */
export interface TextNode {
  readonly _tag: "Text";
  readonly text: string;
}

/** The absence of a child. JSX cannot produce `null`, so this stands in. */
export interface EmptyNode {
  readonly _tag: "Empty";
}

export interface ListNode {
  readonly _tag: "List";
  readonly children: ReadonlyArray<Node>;
}

export interface ElementNode {
  readonly _tag: "Element";
  readonly tag: string;
  readonly props: ElementProps;
  readonly children: Node;
}

/**
 * A keyed list. Each row receives a read-only source for its own item, so
 * replacing an item under the same key updates that row in place. A row's
 * body is an Effect run in the row's own scope, which closes when the row
 * leaves; `For` wraps a plain render in `Effect.succeed`, and `View.list`
 * runs a real setup there.
 */
export interface ForNode<Item = unknown> {
  readonly _tag: "For";
  readonly each: Source<ReadonlyArray<Item>>;
  // Method signatures, as on `ShowNode`: a `ForNode<Task>` is a
  // `ForNode<unknown>`, which is all the tree needs to know.
  keyBy(item: Item): string;
  setup(item: Source<Item>): Effect.Effect<Node, never, Scope.Scope>;
}

/**
 * A branch. `test` decides from the source's value whether the branch is
 * shown; `render` receives a source of that value that exists only while
 * it is, so a narrowed reading of it never has to represent the other case.
 */
export interface ShowNode<A = unknown> {
  readonly _tag: "Show";
  readonly when: Source<A>;
  // Method signatures, so a `ShowNode<boolean>` is a `ShowNode<unknown>` and
  // the tree can hold one without knowing what it tests.
  test(value: A): boolean;
  render(value: Source<A>): Node;
  readonly fallback: Node;
}

/**
 * One branch per case of a tagged union. `key` names the case the value is
 * in; `render` draws that case from a source of the value that exists only
 * while the case holds. The runtime switches branches when the key changes
 * and updates in place while it does not.
 */
export interface MatchNode<A = unknown> {
  readonly _tag: "Match";
  readonly on: Source<A>;
  key(value: A): string;
  render(key: string, value: Source<A>): Node;
}

/**
 * Children drawn under another host node. The portal owns them: they leave
 * when the portal's branch or row does, wherever they were drawn.
 */
export interface PortalNode {
  readonly _tag: "Portal";
  readonly into: unknown;
  readonly children: Node;
}

/**
 * A readiness boundary keeps its content owner alive while presenting a
 * fallback. The runtime owns this node; views only receive it through
 * `Loading` and `Errored`.
 */
/** The two readiness boundaries. */
export type BoundaryKind = "Loading" | "Errored";

export interface RetainedNode {
  readonly _tag: "Retained";
  /**
   * Which boundary this is. A `Loading` fallback waits for data; an
   * `Errored` fallback is a final drawing. An `AwaitAll` render (#22) waits
   * for the first kind only.
   */
  readonly kind: BoundaryKind;
  readonly when: Source<boolean>;
  readonly fallback: Node;
  readonly content: Node;
  /**
   * The runtime started the boundary. `drewFresh` is true when a hydrating
   * host found the server's other branch here and the boundary built its
   * own fresh (#22): only then may its queries show a settle the document
   * holds back until hydration is done.
   */
  readonly started: (drewFresh: boolean) => void;
  /**
   * Subscribes to the registrations that make this boundary pending, heard
   * synchronously inside the registering setup. A row mounted after first
   * paint registers before it writes a node, so the runtime takes the content
   * out of the document first and the row is built detached (#16). `when`
   * still decides when the content returns. Returns the unsubscribe.
   */
  readonly hold?: (listener: () => void) => () => void;
}

/** Control flow in the tree. `control.ts` builds it; `runtime.ts` reads it. */
export type ControlNode =
  | ForNode<unknown>
  | ShowNode<unknown>
  | MatchNode<unknown>
  | PortalNode
  | RetainedNode;

export const Empty: EmptyNode = { _tag: "Empty" };

/** Everything the runtime may find in a child position. */
export type Node = ElementNode | ControlNode | Bound<unknown> | TextNode | ListNode | EmptyNode;

/**
 * What JSX may write in a child position before `parse` tags it. A component
 * may also hand back a raw value, so `parse` accepts the same shapes.
 */
export type Child = Node | string | number | boolean | ReadonlyArray<Child>;

/** A prop the host applies once, at creation. */
export interface StaticValue {
  readonly _tag: "Static";
  readonly value: string | number | boolean;
}

/** Every prop value the runtime understands, once it has been sorted. */
export type PropValue = Bound<unknown> | Prepared | Attached<unknown> | StaticValue;

/** What JSX may write in a prop position, before `classify` sorts it. */
export type RawProp =
  | Child
  | Bound<unknown>
  | Prepared
  | Attached<unknown>
  | ReadonlyArray<Attached<unknown>>;

/**
 * One element's props as JSX wrote them. `children` is a prop like any
 * other, so the index signature covers it and an absent prop is simply a
 * name the record does not hold.
 */
export interface ElementProps {
  readonly [name: string]: RawProp;
}

const isList = (value: RawProp): value is ReadonlyArray<Child> | ReadonlyArray<Attached<unknown>> =>
  Array.isArray(value);

/** A prop marker has no meaning as a child. */
const drawsNothing = (
  value: Node | Prepared | Attached<unknown>,
): value is Prepared | Attached<unknown> =>
  Predicate.or(Predicate.isTagged("Prepared"), Predicate.isTagged("Attached"))(value);

/**
 * Parse one JSX child position into a tagged node. A prepared event has no
 * meaning as a child, so it draws nothing.
 */
export const parse = (child: RawProp): Node => {
  if (isList(child)) {
    return { _tag: "List", children: child.map(parse) };
  }
  if (Predicate.isString(child)) {
    return { _tag: "Text", text: child };
  }
  if (Predicate.isNumber(child)) {
    return { _tag: "Text", text: String(child) };
  }
  if (Predicate.isBoolean(child)) {
    return Empty;
  }
  if (drawsNothing(child)) {
    return Empty;
  }
  return child;
};

/** A missing `children` prop is an empty slot, not a value to parse. */
const parseChildren = (props: ElementProps): Node =>
  Option.match(Option.fromNullishOr(props["children"]), { onNone: () => Empty, onSome: parse });

export const jsx = (tag: Tag, props: ElementProps): Node => {
  if (Predicate.isFunction(tag)) {
    return tag(props);
  }
  return { _tag: "Element", tag, props, children: parseChildren(props) };
};

export const jsxs = jsx;

export const jsxDEV = jsx;

/** `<>...</>` yields its children unchanged. */
export const Fragment: Component = parseChildren;

export declare namespace JSX {
  /** What every JSX expression evaluates to. TypeScript looks for this name. */
  type Element = Node;
  /**
   * Every tag and component this runtime accepts. A component is any function
   * from its own props to a node, so `For` and `Show` fit with no widening.
   */
  type ElementType = string | ((props: never) => Node);
  interface ElementChildrenAttribute {
    readonly children: Child;
  }
  interface IntrinsicElements {
    readonly [tag: string]: ElementProps;
  }
}
