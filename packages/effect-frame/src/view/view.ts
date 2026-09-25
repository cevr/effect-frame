import type { Form } from "effect-frame/actor";
import type { Source } from "effect-frame/actor/client";
import type { Effect, Scope } from "effect";
import { Option, Predicate, identity } from "effect";
import type { HostEvent } from "./host.js";
import type { Node } from "./jsx-runtime.js";

/**
 * A dynamic JSX value. `bind` is the only way to make one, so a reader sees
 * every reactive position in a template. The runtime subscribes to the
 * source inside the view scope and applies the projection where it draws,
 * so a projected row item is read from the row as directly as the item
 * itself; every other JSX value is static.
 *
 * `open` hands the source and its projection to a reader. The source's own
 * type is the binding's business, so it is passed, not stored.
 */
export interface Bound<A> {
  readonly _tag: "Bound";
  readonly open: <R>(read: <S>(source: Source<S>, project: (value: S) => A) => R) => R;
}

/**
 * How a prepared handler meets the host's default action. An `"event"`
 * handler leaves it alone. A `"submit"` handler has the host suppress it
 * first, so a form posts nothing and a link does not navigate; a form's
 * `onSubmit` takes only this kind.
 */
export type PreparedKind = "event" | "submit";

/**
 * A prepared event: the handler and its kind. It is data. The runtime
 * forks the handler into the scope of the view that owns the element, when
 * the host fires.
 */
export interface Prepared<Kind extends PreparedKind = PreparedKind> {
  readonly _tag: "Prepared";
  readonly kind: Kind;
  readonly handler: Handler;
  /**
   * The plain-post description of a command form (#21). Present on a form
   * binding, absent on `event` and on a handler `submit`. The runtime writes
   * it as `method`, `action`, and hidden inputs in every host, so a server
   * render posts with no script and a hydrating client adopts the same nodes.
   */
  readonly post: Option.Option<PlainPost>;
}

/** What a form posts when no script runs. */
export interface PlainPost {
  /** The form route: `{base}/form`. */
  readonly action: string;
  /** A command is never a GET. */
  readonly method: "post";
  /** The `$` fields, `_tag`, and every generated field, in that order. */
  readonly hidden: ReadonlyArray<readonly [name: string, value: string]>;
  /** The values a refused post redraws into the form's own inputs. */
  readonly submitted: Form.FormFields;
  /** The fields a refused post named, marked `aria-invalid`. */
  readonly invalid: ReadonlyArray<string>;
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
    onNone: (): Bound<A | B> => ({ _tag: "Bound", open: (read) => read(source, identity) }),
    onSome: (f): Bound<A | B> => ({ _tag: "Bound", open: (read) => read(source, f) }),
  });

/**
 * What a prepared handler runs: a `Handler` that reads its event, or an
 * Effect run once per event when the handler reads none. An Effect is a
 * description, so running it on each event is what `() => effect` did.
 * Both refuse a failure: a view has no place to return one.
 */
type HandlerWork = Handler | Effect.Effect<unknown>;

/**
 * An Effect is not a function, so the handler form is the one a host can
 * call as it stands, and the Effect form ignores the event it is given.
 */
const toHandler = (work: HandlerWork): Handler => {
  if (Predicate.isFunction(work)) {
    return work;
  }
  return () => work;
};

/**
 * Run the handler's Effect when the host fires. The runtime forks it into
 * the scope of the view that owns the element, so the fiber dies with the
 * view: a `Show` branch's handler ends with the branch, a row's with the
 * row. A handler that reads no event is the Effect itself:
 * `onClick={View.event(addPane)}`.
 *
 * The handler runs on a fiber of its own. Synchronous handler work for an
 * open owner can complete before the host's callback returns, while work that
 * suspends completes later. Tests should supply the action or domain receipt
 * that drives the event and wait for an observed ViewTest condition; `render`
 * only flushes writes already reached by Solid and does not wait for a
 * suspended handler fiber.
 */
export interface Event {
  (handler: Handler): Prepared<"event">;
  (effect: Effect.Effect<unknown>): Prepared<"event">;
}

export const event: Event = (work: HandlerWork): Prepared<"event"> => ({
  _tag: "Prepared",
  kind: "event",
  handler: toHandler(work),
  post: Option.none(),
});

/**
 * `event`, but the host suppresses its default action first: its kind is
 * `"submit"`, which a form's `onSubmit` requires. The form posts nothing
 * without a script; a form that sends a command uses `form`. Like `event`,
 * it takes a handler or the Effect a handler that reads no event would
 * return.
 */
export interface Submit {
  (handler: Handler): Prepared<"submit">;
  (effect: Effect.Effect<unknown>): Prepared<"submit">;
}

export const submit: Submit = (work: HandlerWork): Prepared<"submit"> => ({
  _tag: "Prepared",
  kind: "submit",
  handler: toHandler(work),
  post: Option.none(),
});

/**
 * A view is a function from props to an Effect that produces a node tree:
 * one setup per mounted identity. Setup runs once. State updates never run
 * it again. `E` and `R` stay visible to the mounting application, and
 * `Scope` owns every resource setup opens.
 *
 * A parent composes a child with `yield* Child(props)`, which runs in the
 * parent's own context, so the child's `E` and `R` are visible at the one
 * place they enter. A view is never a JSX tag: a PascalCase tag is a
 * framework tag (`For`, `Show`, `Match`, `Portal`, `Await`, the router's
 * `Link`), a synchronous helper is called as a function, and the runtime
 * runs no Effect found in a tree. `View.bind`, `View.event` and `View.submit` are plain functions,
 * so a plain function that returns a `Node` needs nothing from the view
 * that calls it.
 *
 * Write a view as an arrow that returns `Effect.gen`, or an arrow over one
 * Effect when it yields nothing else. Its type is inferred:
 *
 * ```tsx
 * const Greeting = (props: { readonly greeting: string }) =>
 *   Effect.gen(function* () {
 *     const name = yield* Actor.local(Behavior.value(""));
 *     const type = View.event((event) => Effect.asVoid(name.send(Value.Set(event.value))));
 *     return (
 *       <label>
 *         name <input value={View.bind(name.state)} onInput={type} />
 *         <output>{View.bind(name.state, (text) => `${props.greeting}, ${text}`)}</output>
 *       </label>
 *     );
 *   });
 * ```
 */
export type View<Props, E, R> = (props: Props) => Effect.Effect<Node, E, R>;
