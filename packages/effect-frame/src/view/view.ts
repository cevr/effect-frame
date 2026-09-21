import type { Source } from "effect-frame/actor";
import { select as selectSource } from "effect-frame/actor/client";
import type { Effect } from "effect";
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
 * A view: one setup Effect per mounted identity. Setup runs once. State
 * updates never run it again. `E` and `R` stay visible to the mounting
 * application, and `Scope` owns every resource setup opens.
 *
 * A parent composes a child with `yield* Child.setup(props)`, which runs in
 * the parent's own context. `bind`, `event` and `submit` are module
 * functions, so a child, or a plain function that returns a `Node`, needs
 * nothing from its parent to mark a dynamic value or a handler.
 */
export interface View<Props, E, R> {
  readonly setup: (props: Props) => Effect.Effect<Node, E, R>;
}

export const make = <Props, E, R>(
  setup: (props: Props) => Effect.Effect<Node, E, R>,
): View<Props, E, R> => ({ setup });
