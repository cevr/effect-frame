import { Form } from "effect-frame/actor/client";
import type { Scope } from "effect";
import { Effect, Option } from "effect";
import type { Cleanup, EventHandler, Host, PropertyValue, StaticProps } from "../host.js";
import type { Attached } from "../view.js";
import { attach as attachNode } from "../view.js";

/**
 * The browser host. Property names reach `setProperty` exactly as JSX wrote
 * them: a name the element owns becomes a property, anything else becomes an
 * attribute, so `value` and `disabled` behave and `aria-label` still lands.
 */

/** A DOM node the runtime may parent, text, or listen to. */
export type DomNode = Node;

const asElement = (node: Node): Option.Option<Element> => {
  if (node instanceof Element) {
    return Option.some(node);
  }
  return Option.none();
};

const applyProperty = (node: Node, name: string, value: PropertyValue): void => {
  const element = asElement(node);
  if (Option.isNone(element)) {
    return;
  }
  const target = element.value;
  if (name in target) {
    Reflect.set(target, name, value);
    return;
  }
  if (value === false) {
    target.removeAttribute(name);
    return;
  }
  target.setAttribute(name, String(value));
};

/** An event target that carries the text a person typed. */
interface Valued {
  readonly value: string;
}

const valueOf = (event: Event): string => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const valued: Valued = target;
    return valued.value;
  }
  return "";
};

/**
 * The fields a submission carries, read the way the browser would post
 * them: the form's controls in document order, then the submitter's own
 * name and value when a named button submitted it.
 */
const formOf = (event: Event): Option.Option<Form.FormFields> => {
  const target = event.target;
  if (event.type !== "submit" || !(target instanceof HTMLFormElement)) {
    return Option.none();
  }
  const submitter = Option.filter(
    Option.fromNullishOr(Reflect.get(event, "submitter")),
    (value): value is HTMLButtonElement => value instanceof HTMLButtonElement && value.name !== "",
  );
  const entries: Array<readonly [string, unknown]> = Array.from(new FormData(target));
  Option.map(submitter, (button) => entries.push([button.name, button.value]));
  return Option.some(Form.fromEntries(entries));
};

/**
 * A behaviour for a DOM element. The runtime hands the element it created,
 * so a view can focus it, observe it, or hand it to a widget, in the scope
 * that owns the element. `<input attach={Dom.attach((el) => Effect.sync(() => el.focus()))} />`.
 */
export const attach = (
  run: (element: Element) => Effect.Effect<unknown, never, Scope.Scope>,
): Attached<DomNode> =>
  attachNode<DomNode>((node) =>
    Option.match(asElement(node), { onNone: () => Effect.void, onSome: run }),
  );

/**
 * Resolves on the next animation frame: the browser has laid out and is
 * about to paint. A behaviour that needs layout (a measurement, a scroll to
 * a position that depends on content) yields it first. A behaviour already
 * runs after its element is in the document, which is enough to focus.
 */
export const afterPaint: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void));
  return Effect.sync(() => cancelAnimationFrame(handle));
});

export interface FocusOptions {
  readonly preventScroll?: boolean;
}

/** Focus the element once it is in the document. Composes: `attach={[Dom.scrollIntoView(), Dom.focus()]}`. */
export const focus = (options?: FocusOptions): Attached<DomNode> =>
  attach((element) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement) {
        element.focus({ preventScroll: options?.preventScroll === true });
      }
    }),
  );

/** Scroll the element into view once it is in the document. */
export const scrollIntoView = (options?: ScrollIntoViewOptions): Attached<DomNode> =>
  attach((element) => Effect.sync(() => element.scrollIntoView(options)));

/**
 * Observe the element's size for as long as it is in the document. The
 * observer disconnects with the element's scope.
 */
export const observeSize = (
  onSize: (rect: DOMRectReadOnly) => Effect.Effect<unknown>,
): Attached<DomNode> =>
  attach((element) =>
    Effect.gen(function* () {
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          runFork(onSize(entry.contentRect));
        }
      });
      yield* Effect.acquireRelease(
        Effect.sync(() => observer.observe(element)),
        () => Effect.sync(() => observer.disconnect()),
      );
    }),
  );

const createElement = (tag: string, staticProps: StaticProps): DomNode => {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(staticProps)) {
    applyProperty(element, name, value);
  }
  return element;
};

const createText = (text: string): DomNode => document.createTextNode(text);

export const host: Host<DomNode> = {
  createElement,
  createText,
  createDetachedElement: createElement,
  createDetachedText: createText,
  setProperty: applyProperty,
  insert: (parent, node, anchor) => {
    Option.match(anchor, {
      onNone: () => parent.appendChild(node),
      onSome: (before) => parent.insertBefore(node, before),
    });
  },
  remove: (parent, node) => {
    if (node.parentNode === parent) {
      parent.removeChild(node);
    }
  },
  setText: (node, text) => {
    node.textContent = text;
  },
  addEventListener: (node, name, handler: EventHandler): Cleanup => {
    const listener = (event: Event): void =>
      handler({
        value: valueOf(event),
        preventDefault: () => event.preventDefault(),
        form: formOf(event),
      });
    node.addEventListener(name, listener);
    return () => node.removeEventListener(name, listener);
  },
  attach: (node, run) => run(node),
};

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

export interface HydrationReport {
  /** Server nodes the client built differently. Empty when both agreed. */
  readonly mismatches: ReadonlyArray<string>;
  /** Server nodes the client never claimed. They are removed. */
  readonly unclaimed: number;
}

export interface Hydration {
  readonly host: Host<DomNode>;
  /** Call after `mount`: removes unclaimed server nodes and reports agreement. */
  readonly finish: Effect.Effect<HydrationReport>;
}

const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** Every node under `root` in document order. Comments only separate text. */
const collect = (root: Node): Array<Node> => {
  const out: Array<Node> = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== COMMENT_NODE) {
        out.push(child);
      }
      walk(child);
    }
  };
  walk(root);
  return out;
};

/**
 * A host that adopts the nodes a server rendered instead of creating new
 * ones. The runtime creates nodes in document order, so the next unclaimed
 * server node is the one this call means. A node that does not match is
 * recorded and replaced; once every server node is claimed the host creates
 * normally, which is what a `For` row added later needs.
 */
export const hydrate = (root: Node): Hydration => {
  const pending = collect(root);
  const mismatches: Array<string> = [];
  let cursor = 0;

  const claim = (): Option.Option<Node> => {
    const next = Option.fromNullishOr(pending[cursor]);
    if (Option.isSome(next)) {
      cursor += 1;
    }
    return next;
  };

  /** The client wins: drop a server node and everything under it. */
  const discard = (node: Node): void => {
    while (Option.exists(Option.fromNullishOr(pending[cursor]), (next) => node.contains(next))) {
      cursor += 1;
    }
    Option.map(Option.fromNullishOr(node.parentNode), (parent) => parent.removeChild(node));
  };

  const hydrating: Host<DomNode> = {
    createElement: (tag, staticProps) => {
      const candidate = claim();
      if (Option.isSome(candidate)) {
        const found = asElement(candidate.value);
        if (Option.isSome(found) && found.value.tagName.toLowerCase() === tag.toLowerCase()) {
          return found.value;
        }
        mismatches.push(`expected <${tag}>, found ${describe(candidate.value)}`);
        discard(candidate.value);
      }
      return host.createElement(tag, staticProps);
    },
    createText: (text) => {
      const candidate = claim();
      if (Option.isSome(candidate)) {
        if (candidate.value.nodeType === TEXT_NODE) {
          if (candidate.value.textContent !== text) {
            mismatches.push(`text "${String(candidate.value.textContent)}" became "${text}"`);
            candidate.value.textContent = text;
          }
          return candidate.value;
        }
        mismatches.push(`expected text "${text}", found ${describe(candidate.value)}`);
        discard(candidate.value);
      }
      return host.createText(text);
    },
    createDetachedElement: host.createElement,
    createDetachedText: host.createText,
    setProperty: host.setProperty,
    attach: host.attach,
    insert: (parent, node, anchor) => {
      if (node.parentNode === parent && Option.isNone(anchor)) {
        return;
      }
      if (
        node.parentNode === parent &&
        Option.isSome(anchor) &&
        node.nextSibling === anchor.value
      ) {
        return;
      }
      host.insert(parent, node, anchor);
    },
    remove: host.remove,
    setText: host.setText,
    addEventListener: host.addEventListener,
  };

  const finish = Effect.sync((): HydrationReport => {
    const leftover = pending.slice(cursor);
    for (const node of leftover) {
      Option.map(Option.fromNullishOr(node.parentNode), (parent) => parent.removeChild(node));
    }
    cursor = pending.length;
    return { mismatches: [...mismatches], unclaimed: leftover.length };
  });

  return { host: hydrating, finish };
};

const describe = (node: Node): string => {
  const element = asElement(node);
  if (Option.isSome(element)) {
    return `<${element.value.tagName.toLowerCase()}>`;
  }
  return `text "${String(node.textContent)}"`;
};

/** Read a payload the server wrote with `Html.jsonScript`. */
export const readJsonScript = (id: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(document.getElementById(id)), (script) =>
    Option.fromNullishOr(script.textContent),
  );
