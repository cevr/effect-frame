import type { Source } from "effect-frame/actor";
import { select as selectSource } from "effect-frame/actor/client";
import type { Effect, Scope } from "effect";
import { Option } from "effect";
import type { HostEvent } from "./host.js";
import type { Node } from "./jsx-runtime.js";

/**
 * A dynamic JSX value. `bind` is the only way to make one, so a reader sees
 * every reactive position in a template. The runtime subscribes to
 * `source.changes` inside the view scope; every other JSX value is static.
 */
export interface Bound<A> {
  readonly _tag: "Bound";
  readonly source: Source<A>;
}

/**
 * A prepared event: the handler and whether the host suppresses its default
 * action first. It is data. The runtime forks the handler into the scope of
 * the view that owns the element, when the host fires.
 */
export interface Prepared {
  readonly _tag: "Prepared";
  /** `true` when the host must suppress its default action first. */
  readonly preventDefault: boolean;
  readonly handler: Handler;
}

/**
 * A behaviour attached to an element: an Effect given the host node, run in
 * the scope of the branch or row that owns the element, once the node is in
 * the document. The scope closes when the element leaves, so a listener,
 * an observer, or a fiber the behaviour opened ends with it. It is data in
 * a prop position, like `Prepared`; `attach={[a, b]}` composes several.
 *
 * A method signature, so an `Attached<Element>` is an `Attached<unknown>`
 * and the tree can hold one without knowing its host.
 */
export interface Attached<HostNode = unknown> {
  readonly _tag: "Attached";
  run(node: HostNode): Effect.Effect<unknown, never, Scope.Scope>;
}

/**
 * Make a behaviour for a host's node type. A host module exports the typed
 * form (`Dom.attach`) so a view never names a node type the host cannot
 * produce. There is no node ref: nothing outside the behaviour holds the
 * node, so there is no `Option<Node>` to keep in step with the tree.
 */
export const attach = <HostNode>(
  run: (node: HostNode) => Effect.Effect<unknown, never, Scope.Scope>,
): Attached<HostNode> => ({ _tag: "Attached", run });

/**
 * A handler maps one host event to work. Its failures must already be
 * handled: a view has no place to return one. Defects reach the fiber's
 * error reporter.
 */
export type Handler = (event: HostEvent) => Effect.Effect<unknown>;

/**
 * Mark a source as a dynamic JSX value, optionally through a projection.
 * `bind` is a plain function: it marks a position in the tree, and the
 * runtime subscribes where the tree is mounted. Nothing here discovers a
 * dependency by watching a read.
 */
export interface Bind {
  <A>(source: Source<A>): Bound<A>;
  <A, B>(source: Source<A>, project: (value: A) => B): Bound<B>;
}

export const bind: Bind = <A, B>(source: Source<A>, project?: (value: A) => B): Bound<A | B> =>
  Option.match(Option.fromNullishOr(project), {
    onNone: (): Bound<A | B> => ({ _tag: "Bound", source }),
    onSome: (f): Bound<A | B> => ({ _tag: "Bound", source: selectSource(source, f) }),
  });

/** Project a source into another source. Both stay explicit inputs. */
export const select = selectSource;

/**
 * Run the handler's Effect when the host fires. The runtime forks it into
 * the scope of the view that owns the element, so the fiber dies with the
 * view: a `Show` branch's handler ends with the branch, a row's with the
 * row.
 *
 * The handler runs on a fiber of its own, so a write it makes lands after
 * the host's callback has returned: a script that fires an event and reads
 * an actor in the same tick reads the old value. The write is observable
 * once the runtime has yielded (`render` in a test).
 */
export const event = (handler: Handler): Prepared => ({
  _tag: "Prepared",
  preventDefault: false,
  handler,
});

/** `event`, but the host suppresses its default action first. */
export const submit = (handler: Handler): Prepared => ({
  _tag: "Prepared",
  preventDefault: true,
  handler,
});

export { list, type ListOptions } from "./control.js";

/**
 * A view is a function from props to an Effect that produces a node tree:
 * one setup per mounted identity. Setup runs once. State updates never run
 * it again. `E` and `R` stay visible to the mounting application, and
 * `Scope` owns every resource setup opens.
 *
 * A parent composes a child with `yield* Child(props)`, which runs in the
 * parent's own context, so the child's `E` and `R` are visible at the one
 * place they enter. A view is never a JSX tag: a tag is a synchronous
 * function or an intrinsic name, and the runtime runs no Effect found in a
 * tree. A named view is `Effect.fn("Name")(function* (props) { ... })`,
 * which also names its span; an anonymous one is a plain arrow. `bind`,
 * `event` and `submit` are module functions, so a plain function that
 * returns a `Node` needs nothing from the view that calls it.
 */
export type View<Props, E, R> = (props: Props) => Effect.Effect<Node, E, R>;
