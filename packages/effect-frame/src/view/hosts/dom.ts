import { Form, Streaming } from "effect-frame/actor/client";
import type { Cause, Scope } from "effect";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { boundaryClose, boundaryContent, boundaryPrefix } from "../boundary-mark.js";
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
  /**
   * Boundaries the client drew with the other branch than the server did,
   * content for a fallback or an error fallback for content, because a
   * record the server wrote after its drawing had already settled the query
   * (#22). Expected when a streamed patch arrives before hydration; not a
   * defect, and not counted in `mismatches`. The server's branch was
   * removed, and the client's built fresh.
   */
  readonly resolvedAhead: number;
}

export interface Hydration {
  readonly host: Host<DomNode>;
  /** Call after `mount`: removes unclaimed server nodes and reports agreement. */
  readonly finish: Effect.Effect<HydrationReport>;
}

const TEXT_NODE = 3;
const COMMENT_NODE = 8;

const isOpenMark = (node: Node): boolean =>
  node.nodeType === COMMENT_NODE && String(node.textContent).startsWith(boundaryPrefix);

const isCloseMark = (node: Node): boolean =>
  node.nodeType === COMMENT_NODE && node.textContent === boundaryClose;

const isMark = (node: Node): boolean => isOpenMark(node) || isCloseMark(node);

interface ServerTree {
  /** Every node under the root in document order. */
  readonly nodes: Array<Node>;
  /** Every boundary open mark in document order (#22). */
  readonly opens: Array<Node>;
}

/** The server's nodes under `root`. A comment only separates text or marks a boundary. */
const collect = (root: Node): ServerTree => {
  const nodes: Array<Node> = [];
  const opens: Array<Node> = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== COMMENT_NODE) {
        nodes.push(child);
      }
      if (isOpenMark(child)) {
        opens.push(child);
      }
      walk(child);
    }
  };
  walk(root);
  return { nodes, opens };
};

/** The close mark that pairs with `open`: marks nest, and a pair shares one parent. */
const closeOf = (open: Node): Option.Option<Node> => {
  let depth = 0;
  let current = Option.fromNullishOr(open.nextSibling);
  while (Option.isSome(current)) {
    const node = current.value;
    if (isOpenMark(node)) {
      depth += 1;
    }
    if (isCloseMark(node)) {
      if (depth === 0) {
        return current;
      }
      depth -= 1;
    }
    current = Option.fromNullishOr(node.nextSibling);
  }
  return Option.none();
};

/** `open`, `close`, and every node between them, in order. */
const rangeOf = (open: Node, close: Node): Array<Node> => {
  const out: Array<Node> = [open];
  let current = Option.fromNullishOr(open.nextSibling);
  while (Option.isSome(current) && current.value !== close) {
    out.push(current.value);
    current = Option.fromNullishOr(current.value.nextSibling);
  }
  out.push(close);
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
  const server = collect(root);
  const pending = server.nodes;
  const opens = server.opens;
  const indexOf = new Map<Node, number>(pending.map((node, index) => [node, index]));
  const mismatches: Array<string> = [];
  let cursor = 0;
  let markCursor = 0;
  let resolvedAhead = 0;

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

  const connected = (node: Node): boolean => root.contains(node);

  /** Skip server nodes a removed range took with it. */
  const skipRemoved = (): void => {
    while (Option.exists(Option.fromNullishOr(pending[cursor]), (next) => !connected(next))) {
      cursor += 1;
    }
    while (Option.exists(Option.fromNullishOr(opens[markCursor]), (next) => !connected(next))) {
      markCursor += 1;
    }
  };

  /**
   * A readiness boundary starts (#22). The runtime starts the boundaries the
   * server drew in document order, so its marks are the next open mark. When
   * the server drew the same branch, the marks go and the branch claims its
   * nodes. When it drew the other one, in either direction, the whole range
   * goes, and the boundary builds its branch fresh: a record the server
   * wrote after its drawing settled the query first.
   */
  const adoptBoundary = (shown: boolean): boolean => {
    skipRemoved();
    const found = Option.fromNullishOr(opens[markCursor]);
    if (Option.isNone(found)) {
      return false;
    }
    const open = found.value;
    markCursor += 1;
    const close = closeOf(open);
    if (Option.isNone(close)) {
      return false;
    }
    const drewContent = open.textContent === boundaryContent;
    if (drewContent === shown) {
      open.parentNode?.removeChild(open);
      close.value.parentNode?.removeChild(close.value);
      return false;
    }
    for (const node of rangeOf(open, close.value)) {
      node.parentNode?.removeChild(node);
    }
    skipRemoved();
    resolvedAhead += 1;
    return true;
  };

  /** A server node the client has not claimed yet. */
  const unclaimed = (node: Node): boolean =>
    Option.exists(Option.fromNullishOr(indexOf.get(node)), (index) => index >= cursor);

  /**
   * A node the client created goes before the server children of its parent
   * that are still unclaimed, and before the boundary marks among them:
   * those come later in the document. They are the tail of the parent's
   * children, so the walk is from the end and stops at the first node that
   * is neither. A parent the client created has no server child, so the
   * walk ends at once.
   */
  const nextServerChild = (parent: Node): Option.Option<Node> => {
    if (parent !== root && !indexOf.has(parent)) {
      return Option.none();
    }
    let anchor = Option.none<Node>();
    let current = Option.fromNullishOr(parent.lastChild);
    while (Option.isSome(current)) {
      const node = current.value;
      if (unclaimed(node) || isMark(node)) {
        anchor = current;
      } else if (node.nodeType !== COMMENT_NODE) {
        break;
      }
      current = Option.fromNullishOr(node.previousSibling);
    }
    return anchor;
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
      host.insert(
        parent,
        node,
        Option.orElse(anchor, () => nextServerChild(parent)),
      );
    },
    remove: host.remove,
    setText: host.setText,
    addEventListener: host.addEventListener,
    adoptBoundary,
  };

  const finish = Effect.sync((): HydrationReport => {
    const leftover = pending.slice(cursor);
    for (const node of leftover) {
      Option.map(Option.fromNullishOr(node.parentNode), (parent) => parent.removeChild(node));
    }
    cursor = pending.length;
    // Marks of a boundary the client never started go too.
    for (const open of opens.slice(markCursor).filter(connected)) {
      Option.map(closeOf(open), (close) => close.parentNode?.removeChild(close));
      open.parentNode?.removeChild(open);
    }
    markCursor = opens.length;
    return { mismatches: [...mismatches], unclaimed: leftover.length, resolvedAhead };
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

// ---------------------------------------------------------------------------
// Streamed documents (#22)
// ---------------------------------------------------------------------------

const decodeRecord = Schema.decodeUnknownOption(Streaming.RecordJson);
const decodeSeed = Schema.decodeUnknownOption(Streaming.SeedJson);

const noRecords: ReadonlyArray<Streaming.StreamRecord> = [];

/**
 * The records a streamed document holds, and the ones the parser appends
 * after this call. Pass the result to `Streaming.resume` before `mount`.
 *
 * A `MutationObserver` on the record container, nothing else: no record is
 * a script that runs. The observer is installed before the records already
 * present are read, and each record element is read once, when its text
 * decodes, so a record the parser appends between the two, or appends in
 * parts, is neither lost nor read twice. `later`
 * completes on `Closed`, or when the parser has finished the document
 * without one: a cut response. An `AwaitAll` document has no container; its
 * seed script is read instead, and `later` is empty.
 *
 * A record that does not decode is skipped. The query it named then settles
 * as `StreamEnded` and reads again.
 */
export const readRecords: Effect.Effect<Streaming.DocumentRecords, never, Scope.Scope> = Effect.gen(
  function* () {
    const seeded = Option.getOrElse(
      Option.flatMap(readJsonScript(Streaming.seedId), decodeSeed),
      () => noRecords,
    );
    const found = Option.fromNullishOr(document.getElementById(Streaming.containerId));
    if (Option.isNone(found)) {
      return { present: seeded, later: Stream.empty };
    }
    const container = found.value;
    const seen = new WeakSet<Element>();
    const queue = yield* Queue.unbounded<Streaming.StreamRecord, Cause.Done>();
    let ended = false;

    // A record is read once it decodes, and only then marked seen. The parser
    // may append a large record's text in more than one step, and tells no
    // observer; a part of a JSON object never decodes, so a record is never
    // read half written. The server writes a node after each record, so the
    // scan that follows its last text comes at once. One that never decodes
    // is skipped when the document ends.
    const scan = (): ReadonlyArray<Streaming.StreamRecord> =>
      Array.from(container.querySelectorAll(`script.${Streaming.recordClass}`)).flatMap(
        (element) => {
          if (seen.has(element)) {
            return [];
          }
          const record = decodeRecord(element.textContent);
          if (Option.isSome(record)) {
            seen.add(element);
          }
          return Option.toArray(record);
        },
      );

    const deliver = (records: ReadonlyArray<Streaming.StreamRecord>): void => {
      for (const record of records) {
        if (ended) {
          return;
        }
        Queue.offerUnsafe(queue, record);
        if (record._tag === "Closed") {
          ended = true;
          Queue.endUnsafe(queue);
        }
      }
    };

    const finish = (): void => {
      deliver(scan());
      if (!ended) {
        ended = true;
        Queue.endUnsafe(queue);
      }
    };

    const parsing = document.readyState === "loading";
    if (parsing) {
      const observer = new MutationObserver(() => deliver(scan()));
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          observer.observe(container, { childList: true });
          document.addEventListener("DOMContentLoaded", finish, { once: true });
        }),
        () =>
          Effect.sync(() => {
            observer.disconnect();
            document.removeEventListener("DOMContentLoaded", finish);
          }),
      );
    }
    const present = scan();
    if (!parsing || present.some((record) => record._tag === "Closed")) {
      return { present: [...seeded, ...present], later: Stream.empty };
    }
    return { present: [...seeded, ...present], later: Stream.fromQueue(queue) };
  },
);
