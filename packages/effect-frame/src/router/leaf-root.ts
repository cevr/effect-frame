import type { Attached, Child, Node } from "effect-frame/view";
import type { ElementNode, ElementProps } from "../view/jsx-runtime.js";
import { View } from "effect-frame/view";
import { Effect, Option, Predicate, Ref } from "effect";

/**
 * PRIVATE (#31). The root of a leaf's own view: the node focus moves to
 * when that leaf enters. See `docs/design/navigation-behavior.md`.
 *
 * A leaf whose view returns an element gets `tabindex="-1"` on it (unless
 * the view wrote a `tabindex` itself, or the element is
 * focusable by the platform already), so it is focusable by the router and
 * not reachable with Tab, and a behaviour that records the element's host
 * node while it is in the document. A view that returns anything else (a
 * fragment, a list, a branch) has no root element, and focus is not moved.
 * No `autofocus` is written: the browser would act on it at a document
 * load, which is the browser's own, never the router's.
 */

/** The host node at a leaf's root while it is in the document. */
export type RootCell = Ref.Ref<Option.Option<unknown>>;

export const makeCell = (): RootCell => Ref.makeUnsafe(Option.none<unknown>());

/** An `attach` prop value, or one entry of a list of them. */
type AttachEntry = ElementProps[string] | Child;

const isAttached = (value: AttachEntry): value is Attached<unknown> =>
  Predicate.isTagged(value, "Attached");

/** The attachments a JSX `attach` prop already holds, in order. */
const attachmentsOf = (
  raw: Option.Option<ElementProps[string]>,
): ReadonlyArray<Attached<unknown>> =>
  Option.match(raw, {
    onNone: () => [],
    onSome: (value) => {
      if (Array.isArray(value)) {
        return value.filter(isAttached);
      }
      return Option.toArray(Option.liftPredicate(value, isAttached));
    },
  });

/** Record the element while it is in the document. */
const recorder = (cell: RootCell): Attached<unknown> =>
  View.attach<unknown>((node) =>
    Effect.acquireRelease(Ref.set(cell, Option.some(node)), () =>
      Ref.update(cell, (current) => Option.filter(current, (held) => held !== node)),
    ),
  );

type Prop = ElementProps[string];

/** The prop the view wrote under `name`, the attribute's HTML spelling. */
const propOf = (element: ElementNode, name: string): Option.Option<Prop> =>
  Option.fromNullishOr(element.props[name]);

/**
 * A value bound to a source is only known once it is drawn. The router
 * treats it as focusable: a control the author may enable keeps its Tab
 * order, at the cost of router focus while it is off.
 */
const isBound = (value: Prop): boolean => Predicate.isTagged(value, "Bound");

/** An attribute that is present: written, and not `false`. */
const present = (value: Prop): boolean => value !== false;

/** `contenteditable` states that make an editing host: "", "true", "plaintext-only". */
const editable = (value: Prop): boolean => {
  if (isBound(value) || value === true) {
    return true;
  }
  return Predicate.isString(value) && ["", "true", "plaintext-only"].includes(value.toLowerCase());
};

/** Elements the platform puts in the Tab order when one attribute is present. */
const focusableWith = new Map<string, string>([
  ["a", "href"],
  ["area", "href"],
  ["audio", "controls"],
  ["video", "controls"],
]);
const alwaysFocusable = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "embed",
  "summary",
]);

/**
 * Whether the root needs no `tabindex` from the router: the view wrote one
 * (any value), or the element is focusable by the
 * platform already. A natively focusable root keeps its place in the Tab
 * order. A disabled control still counts as focusable: its `disabled`
 * state is not read (a known limit).
 */
const focusableAlready = (element: ElementNode): boolean => {
  if (Option.isSome(propOf(element, "tabindex"))) {
    return true;
  }
  if (Option.exists(propOf(element, "contenteditable"), editable)) {
    return true;
  }
  const tag = element.tag.toLowerCase();
  if (alwaysFocusable.has(tag)) {
    return true;
  }
  return Option.exists(Option.fromNullishOr(focusableWith.get(tag)), (name) =>
    Option.exists(propOf(element, name), present),
  );
};

/** Mark a leaf view's root element. Any other node is returned as it is. */
export const mark = (node: Node, cell: RootCell): Node => {
  if (node._tag !== "Element") {
    return node;
  }
  const attachments = [
    ...attachmentsOf(Option.fromNullishOr(node.props["attach"])),
    recorder(cell),
  ];
  if (focusableAlready(node)) {
    return { ...node, props: { ...node.props, attach: attachments } };
  }
  // Focusable by the router, not reachable with Tab.
  return { ...node, props: { ...node.props, tabindex: "-1", attach: attachments } };
};
