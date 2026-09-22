import type { Option } from "effect";

/**
 * What a renderer must provide. The runtime knows nothing about the DOM or a
 * terminal; it only creates, orders, and writes nodes through this interface.
 *
 * Every operation is synchronous. Host writes run inside the reactive graph,
 * which has no place to await an Effect.
 */
export interface Host<Node> {
  readonly createElement: (tag: string, staticProps: StaticProps) => Node;
  readonly createText: (text: string) => Node;
  /**
   * Create a node without acquiring an existing connected node.
   *
   * Hydrating hosts use this for content that is owned but currently hidden.
   * Other hosts may omit the capability because their normal constructors
   * already create detached values.
   * A custom host whose normal constructors acquire connected nodes must
   * provide both detached constructors.
   */
  readonly createDetachedElement?: (tag: string, staticProps: StaticProps) => Node;
  readonly createDetachedText?: (text: string) => Node;
  readonly setProperty: (node: Node, name: string, value: PropertyValue) => void;
  /** Insert `node` before `anchor`, or at the end when the anchor is absent. */
  readonly insert: (parent: Node, node: Node, anchor: Option.Option<Node>) => void;
  readonly remove: (parent: Node, node: Node) => void;
  readonly setText: (node: Node, text: string) => void;
  /** Returns the cleanup that detaches the listener. */
  readonly addEventListener: (node: Node, name: string, handler: EventHandler) => Cleanup;
  /**
   * Hand a node to the behaviours attached to it, once it is in the
   * document. A live host calls `run` with the node; the server host, which
   * has no live node, calls nothing, so a behaviour never runs against an
   * HTML string.
   */
  readonly attach: (node: Node, run: (node: Node) => void) => void;
}

/**
 * What a host can write to a node. A binding may carry any value a selector
 * produced, so the host renders it the way it renders text.
 */
export type PropertyValue = string | number | boolean;

/** Props with no dynamic binding. The host applies them at creation. */
export type StaticProps = Readonly<Record<string, PropertyValue>>;

/**
 * What a host hands an event handler. The DOM gives an `Event`; OpenTUI gives
 * the input's new text. Both carry a value the handler may read, and a
 * default action the view may suppress.
 */
export interface HostEvent {
  /** The event's own value, when it has one: an input's text. */
  readonly value: string;
  readonly preventDefault: () => void;
}

export type EventHandler = (event: HostEvent) => void;

export type Cleanup = () => void;
