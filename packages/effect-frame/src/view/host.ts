import type { Form } from "effect-frame/actor/client";
import type { Option } from "effect";
import type { BoundaryKind } from "./jsx-runtime.js";

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
  /**
   * Streamed documents (#22), server side. A new comment pair for one
   * readiness boundary. The runtime puts the open mark before the boundary's
   * nodes and the close mark after them, and tells the pair which branch is
   * shown. Only the HTML host writes marks.
   */
  readonly boundaryMarks?: (kind: BoundaryKind) => BoundaryMarks<Node>;
  /**
   * Streamed documents (#22), hydration side. A readiness boundary starts,
   * showing its content when `shown` is true. The host reads the next
   * boundary mark pair the server wrote. Returns `true` when the server drew
   * the other branch: the host has removed that branch's nodes, and the
   * boundary builds its shown branch fresh rather than claiming nodes.
   */
  readonly adoptBoundary?: (shown: boolean) => boolean;
  /**
   * Streamed documents (#22), server side. The runtime started a setup that
   * may finish after the frame is drawn: a list row's setup, for one. Call
   * the returned function when it ends or its scope closes. An `AwaitAll`
   * render waits for every one, since a late setup may declare a query or
   * draw nodes. Only that render's host counts them.
   */
  readonly setupStarted?: () => () => void;
}

/** The comment pair around one readiness boundary in server HTML (#22). */
export interface BoundaryMarks<Node> {
  readonly open: Node;
  readonly close: Node;
  /** Record the branch the boundary shows now. */
  readonly show: (shown: boolean) => void;
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
  /**
   * The fields a form submission carries, in document order, when the event
   * is one. A host with no forms always gives `None`.
   */
  readonly form: Option.Option<Form.FormFields>;
}

export type EventHandler = (event: HostEvent) => void;

export type Cleanup = () => void;
