import type { ActorTransport } from "effect-frame/actor/client";
import { QueryCache, Streaming, queryCacheLayer } from "effect-frame/actor/client";
import {
  Context,
  Deferred,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { BoundaryMarks, Cleanup, Host, PropertyValue, StaticProps } from "../host.js";
import type { BoundaryKind } from "../jsx-runtime.js";
import { mount, render } from "../runtime.js";
import type { View } from "../view.js";
import { boundaryClose, boundaryFallback, boundaryOpen } from "../boundary-mark.js";

/**
 * The server host. It builds an in-memory tree and serializes it to HTML.
 * Everything it writes is escaped; a value from an actor can never become
 * markup. Adjacent text nodes are separated by an empty comment so the
 * hydrating host sees the same number of text nodes the server created.
 */

export interface HtmlElement {
  readonly _tag: "Element";
  readonly tag: string;
  readonly attributes: Map<string, PropertyValue>;
  readonly children: Array<HtmlNode>;
}

export interface HtmlText {
  readonly _tag: "Text";
  text: string;
}

/** A comment. Only a boundary mark is one (#22); its text is never user data. */
export interface HtmlComment {
  readonly _tag: "Comment";
  text: string;
  /** The open mark of a `Loading` boundary: its fallback waits for data. */
  readonly waits: boolean;
}

export type HtmlNode = HtmlElement | HtmlText | HtmlComment;

export const element = (tag: string): HtmlElement => ({
  _tag: "Element",
  tag,
  attributes: new Map(),
  children: [],
});

export const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const escapeAttribute = (text: string): string => escapeText(text).replaceAll('"', "&quot;");

/**
 * JSON inside a `<script>` must never close the element. `<`, `>`, and `&`
 * become escapes JSON parsers accept, and the two line separators that
 * break older parsers go the same way.
 */
export const escapeJsonScript = (json: string): string =>
  json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");

const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Separates adjacent text nodes so the browser parser keeps them apart. */
export const textSeparator = "<!---->";

const serializeAttributes = (attributes: ReadonlyMap<string, PropertyValue>): string => {
  let out = "";
  for (const [name, value] of attributes) {
    if (value === false) {
      continue;
    }
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    out += ` ${name}="${escapeAttribute(String(value))}"`;
  }
  return out;
};

export const serializeChildren = (children: ReadonlyArray<HtmlNode>): string => {
  let out = "";
  let previousWasText = false;
  for (const child of children) {
    if (child._tag === "Text" && previousWasText) {
      out += textSeparator;
    }
    out += serialize(child);
    // A comment keeps the text nodes around it apart too.
    previousWasText = child._tag === "Text";
  }
  return out;
};

export const serialize = (node: HtmlNode): string => {
  if (node._tag === "Text") {
    return escapeText(node.text);
  }
  if (node._tag === "Comment") {
    return `<!--${node.text}-->`;
  }
  const open = `<${node.tag}${serializeAttributes(node.attributes)}>`;
  if (voidElements.has(node.tag)) {
    return open;
  }
  return `${open}${serializeChildren(node.children)}</${node.tag}>`;
};

const removeChild = (parent: HtmlNode, node: HtmlNode): void => {
  if (parent._tag !== "Element") {
    return;
  }
  const index = parent.children.indexOf(node);
  if (index >= 0) {
    parent.children.splice(index, 1);
  }
};

/** Attribute names as the DOM host would treat them, so both hosts agree. */
const attributeName = (name: string): string => {
  if (name === "className") {
    return "class";
  }
  if (name === "htmlFor") {
    return "for";
  }
  return name;
};

/**
 * The comment pair around a readiness boundary (#22). The open mark names
 * the branch the boundary shows when the tree is serialized.
 */
const boundaryMarks =
  (changed: () => void) =>
  (kind: BoundaryKind): BoundaryMarks<HtmlNode> => {
    const open: HtmlComment = {
      _tag: "Comment",
      text: boundaryOpen(false),
      waits: kind === "Loading",
    };
    const close: HtmlComment = { _tag: "Comment", text: boundaryClose, waits: false };
    return {
      open,
      close,
      show: (shown) => {
        open.text = boundaryOpen(shown);
        changed();
      },
    };
  };

/** Whether a `Loading` boundary under `node` shows its fallback now. */
const waitsForData = (node: HtmlNode): boolean => {
  if (node._tag === "Comment") {
    return node.waits && node.text === boundaryFallback;
  }
  if (node._tag === "Text") {
    return false;
  }
  return node.children.some(waitsForData);
};

/**
 * The source bindings of one server drawing (#22). A value travels from a
 * source to the drawing on a fiber, so the drawing can lag its sources; the
 * seed is read from the cache, which never lags. `catchUp` brings every
 * binding to its source's current value and draws, so a drawing read after
 * it shows what its sources hold now.
 */
interface Bindings {
  readonly bound: (catchUp: () => void) => () => void;
  readonly catchUp: Effect.Effect<void>;
}

const makeBindings = (): Bindings => {
  const live = new Set<{ readonly catchUp: () => void }>();
  return {
    bound: (catchUp) => {
      const one = { catchUp };
      live.add(one);
      return () => void live.delete(one);
    },
    catchUp: Effect.andThen(
      Effect.sync(() => {
        // A catch-up may draw a branch that binds more sources: those read
        // their current value when they bind.
        for (const one of [...live]) {
          one.catchUp();
        }
      }),
      render,
    ),
  };
};

/** The records a pass read, and whether the drawing is at their instant. */
interface Read<A> {
  readonly records: A;
  /**
   * The two reads around the last catch-up agreed. False only when the
   * limit ended the passes first: the records are the last pass's second
   * read, taken right after that pass drew.
   */
  readonly agreed: boolean;
}

/**
 * Read the records a document writes beside its drawing, and bring the
 * drawing to the same instant (#22): read, catch up, read again, until the
 * two reads agree. A query that settles between the reads is read again,
 * so the drawing never shows less than the records carry, and never more.
 * `of` picks what the records must agree on.
 *
 * Records that change on every pass would keep this reading for ever, so
 * the document's limit ends it (review round 1, finding 4). A pass that
 * starts after the limit is the last one, and its records are written with
 * `agreed: false`. An entry that moved inside that pass may then not agree
 * with the drawing; the client redraws it.
 */
const readDrawn = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  of: (records: A) => unknown,
  bindings: Bindings,
  limit: Deferred.Deferred<void>,
): Effect.Effect<Read<A>, E, R> =>
  Effect.gen(function* () {
    let before = yield* read;
    yield* bindings.catchUp;
    let after = yield* read;
    let agreed = Equal.equals(of(before), of(after));
    while (!agreed && !Deferred.isDoneUnsafe(limit)) {
      before = after;
      yield* bindings.catchUp;
      after = yield* read;
      agreed = Equal.equals(of(before), of(after));
    }
    return { records: after, agreed };
  });

/** Run `closeWhen` once in the current Scope; the Deferred completes when it does. */
const limitOf = (closeWhen: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const limit = yield* Deferred.make<void>();
    yield* Effect.forkScoped(Effect.andThen(closeWhen, Deferred.succeed(limit, void 0)));
    return limit;
  });

/**
 * The server host. `changed` runs when a boundary switches branch or a node
 * leaves the tree: the two writes after which no `Loading` fallback may be
 * left (#22). `bindings` hears every source the drawing binds.
 */
const makeHost = (
  changed: () => void,
  setupStarted: Option.Option<() => () => void> = Option.none(),
  bindings: Option.Option<Bindings> = Option.none(),
): Host<HtmlNode> => ({
  createElement: (tag: string, staticProps: StaticProps) => {
    const node = element(tag);
    for (const [name, value] of Object.entries(staticProps)) {
      node.attributes.set(attributeName(name), value);
    }
    return node;
  },
  createText: (text: string): HtmlText => ({ _tag: "Text", text }),
  createDetachedElement: (tag: string, staticProps: StaticProps) => {
    const node = element(tag);
    for (const [name, value] of Object.entries(staticProps)) {
      node.attributes.set(attributeName(name), value);
    }
    return node;
  },
  createDetachedText: (text: string): HtmlText => ({ _tag: "Text", text }),
  setProperty: (node, name, value) => {
    if (node._tag === "Element") {
      node.attributes.set(attributeName(name), value);
    }
  },
  insert: (parent, node, anchor) => {
    if (parent._tag !== "Element") {
      return;
    }
    removeChild(parent, node);
    Option.match(anchor, {
      onNone: () => void parent.children.push(node),
      onSome: (before) => {
        const index = parent.children.indexOf(before);
        if (index < 0) {
          parent.children.push(node);
          return;
        }
        parent.children.splice(index, 0, node);
      },
    });
  },
  remove: (parent, node) => {
    removeChild(parent, node);
    changed();
  },
  setText: (node, text) => {
    if (node._tag === "Text") {
      node.text = text;
    }
  },
  // The server never receives an event. The listener is a no-op and so is its cleanup.
  addEventListener: (): Cleanup => () => {},
  // The server has no live node, so a behaviour never runs here.
  attach: () => {},
  boundaryMarks: boundaryMarks(changed),
  ...Option.match(setupStarted, {
    onNone: () => ({}),
    onSome: (started) => ({ setupStarted: started }),
  }),
  ...Option.match(bindings, {
    onNone: () => ({}),
    onSome: (drawn) => ({ sourceBound: drawn.bound }),
  }),
});

export const host: Host<HtmlNode> = makeHost(() => {});

/**
 * Render one view to HTML. The render owns its own scope: setup runs, one
 * frame is drawn, the tree is serialized, and every resource setup opened
 * is released before the string returns. Two requests never share state.
 */
export const renderToString = Effect.fn("Html.renderToString")(function* <Props, E, R>(
  view: View<Props, E, R>,
  props: Props,
) {
  const scope = yield* Scope.make();
  const root = element("#root");
  const html = yield* mount(view, props, host, root).pipe(
    Effect.andThen(render),
    Effect.map(() => serializeChildren(root.children)),
    Scope.provide(scope),
    Effect.onExit((exit) => Scope.close(scope, exit)),
  );
  return html;
});

/**
 * The close tag, built from parts, so no bundle of this module holds
 * `</script`. A bundle that keeps this host may be written inline in a
 * page's script.
 */
const scriptClose = ["<", "/script>"].join("");

/** A JSON payload the client reads back by id. See `Dom.readJsonScript`. */
export const jsonScript = (id: string, json: string): string =>
  `<script type="application/json" id="${escapeAttribute(id)}">${escapeJsonScript(json)}${scriptClose}`;

// ---------------------------------------------------------------------------
// Streamed documents (#22)
// ---------------------------------------------------------------------------

const encodeRecord = Schema.encodeSync(Streaming.RecordJson);
const encodeSeed = Schema.encodeSync(Streaming.SeedJson);

/**
 * One record of a streamed document, as the script the client reads. It is
 * JSON, never run: the same escaping as `jsonScript`, a class for an id.
 *
 * An empty comment follows it. A parser may append a large record's text in
 * steps, and a browser tells no observer about text it appends, so the
 * client reads a record once the node after it is there. The comment is
 * that node, in the same write, so a record is read as soon as it is whole.
 */
export const streamRecord = (record: Streaming.StreamRecord): string =>
  `<script type="application/json" class="${Streaming.recordClass}">${escapeJsonScript(encodeRecord(record))}${scriptClose}<!---->`;

/**
 * The document around one view. The view's markup goes between `head` and
 * `tail`; the query records go after `tail`; `bootstrap` is the page's
 * module script; `end` closes the document.
 */
export interface Document {
  /** The doctype, the head, and the mount element's open tag. */
  readonly head: string;
  /** The mount element's close tag, then any settled payload: actor resume, form issues. */
  readonly tail: string;
  /** The module script. A streamed document writes it before the later patches. */
  readonly bootstrap: string;
  /** `</body></html>`. */
  readonly end: string;
}

/**
 * Each request renders over its own cache, released when its response ends
 * (#28). The layer is fresh: a caller whose context was built from the same
 * layer carries a memo map that would hand back the caller's own cache.
 */
/**
 * Where a pipeline takes its query cache from. A public render builds a
 * fresh one (`requestCache`); the router's server document passes the one
 * cache its request already holds, so its checks and its drawing share it.
 */
export type CacheSource = Effect.Effect<QueryCache["Service"], never, Scope.Scope>;

export const requestCache: CacheSource = Effect.map(
  Layer.build(Layer.fresh(queryCacheLayer)),
  (context) => Context.get(context, QueryCache),
);

/**
 * What a document pipeline draws: something mounted over `root` on `host`
 * in the current scope. A view is one; the router's server document mounts
 * a routed tree (`src/router/document.ts`). Internal: the public `Html`
 * namespace (`html-public.ts`) takes a view and its props.
 */
export type Drawing<E, R> = (
  host: Host<HtmlNode>,
  root: HtmlElement,
) => Effect.Effect<unknown, E, R>;

/** What a document pipeline needs: the drawing's services but its cache and Scope. */
export type Drawn<R> = Exclude<Exclude<R, QueryCache>, Scope.Scope> | ActorTransport;

/** The drawing of one view. */
const viewDrawing =
  <Props, E, R>(view: View<Props, E, R>, props: Props): Drawing<E, R | Scope.Scope> =>
  (over, root) =>
    mount(view, props, over, root);

/** Mount a drawing over `root` in the current scope and draw one frame. */
const draw = <E, R>(
  drawing: Drawing<E, R>,
  cache: QueryCache["Service"],
  root: HtmlElement,
  over: Host<HtmlNode> = host,
): Effect.Effect<void, E, Exclude<R, QueryCache>> =>
  drawing(over, root).pipe(Effect.andThen(render), Effect.provideService(QueryCache, cache));

/**
 * Render one view as a streamed document (#22): the shell and its
 * fallbacks in the first chunk, then one patch per query as it settles,
 * then `Closed`. The first chunk holds the view's markup, `tail`, the open
 * record container, a placeholder for every query the shell declared, the
 * patches already due, and `bootstrap`, in that order, so the page's script
 * is fetched while the queries are still in flight.
 *
 * The render holds its own query cache and its own scope for as long as the
 * stream runs: the queries the shell declared keep reading, and both are
 * released when the stream ends. `Closed` is written on every exit path
 * but a failed shell, which writes nothing. `options.closeWhen` is the
 * time limit, and it is required: a query still open when it completes
 * settles on the client as `StreamEnded`, and the client reads it again.
 */
export const renderToStream = <Props, E, R>(
  view: View<Props, E, R>,
  props: Props,
  document: Document,
  options: Streaming.ShellOptions,
): Stream.Stream<string, E, Drawn<R>> => streamDrawing(viewDrawing(view, props), document, options);

/** `renderToStream` over any drawing. Internal: see `Drawing`. */
export const streamDrawing = <E, R>(
  drawing: Drawing<E, R>,
  document: Document,
  options: Streaming.ShellOptions,
): Stream.Stream<string, E, Drawn<R>> =>
  Stream.unwrap(streamPrepared(drawing, document, options, requestCache));

/**
 * The shell of a streamed document, drawn in the current Scope, and the
 * stream that writes it and then the records. The cache and the drawing
 * live as long as that Scope: the router's server document draws before it
 * answers, so it can refuse a render that is not ready in time.
 */
export const streamPrepared = <E, R>(
  drawing: Drawing<E, R>,
  document: Document,
  options: Streaming.ShellOptions,
  cacheOf: CacheSource,
): Effect.Effect<Stream.Stream<string>, E, Exclude<R, QueryCache> | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* cacheOf;
    const root = element("#root");
    const bindings = makeBindings();
    yield* draw(
      drawing,
      cache,
      root,
      makeHost(() => {}, Option.none(), Option.some(bindings)),
    );
    // The limit runs once: the shell's reads and the patch stream share it.
    const limit = yield* limitOf(options.closeWhen);
    // The shell shows every value the settled patches carry, and no value
    // an entry still behind a placeholder holds.
    const { records } = yield* readDrawn(
      Effect.provideService(
        Streaming.shell({ closeWhen: Deferred.await(limit) }),
        QueryCache,
        cache,
      ),
      (read) => [read.placeholders, read.settled],
      bindings,
      limit,
    );
    const shell = serializeChildren(root.children);
    const first = [
      document.head,
      shell,
      document.tail,
      `<div id="${Streaming.containerId}" hidden>`,
      ...records.placeholders.map(streamRecord),
      ...records.settled.map(streamRecord),
      document.bootstrap,
    ].join("");
    return Stream.concat(
      Stream.succeed(first),
      Stream.concat(
        Stream.map(records.later, streamRecord),
        Stream.succeed(`</div>${document.end}`),
      ),
    );
  });

/**
 * Render one view once its drawing waits for nothing (#22, the `AwaitAll`
 * mode): every query it declares has settled, and no `Loading` boundary in
 * the tree shows its fallback. The drawing is live while it waits, so rows
 * set up later and queries declared by content that appears later count
 * too. No record channel is written: the settled values go in one seed
 * script after `tail`, so the client's cache holds them before it mounts
 * and hydration agrees node for node.
 *
 * A setup the runtime runs after the frame, such as a list row's, holds
 * the render until it ends, inside a boundary or not: it may declare a
 * query or draw nodes.
 *
 * `options.closeWhen` is the time limit, and it is required. When it
 * completes first, the drawing is serialized as it is: a query still open
 * has no seed, its boundary shows the fallback, and the client reads it. A
 * `Loading` boundary that registers no query shows its fallback for ever,
 * so such a page always waits for the limit.
 */
export const renderAwaitAll = <Props, E, R>(
  view: View<Props, E, R>,
  props: Props,
  document: Document,
  options: Streaming.ShellOptions,
): Effect.Effect<string, E, Drawn<R>> =>
  awaitAllDrawing(viewDrawing(view, props), document, options, requestCache);

/** `renderAwaitAll` over any drawing. Internal: see `Drawing`. */
export const awaitAllDrawing = <E, R>(
  drawing: Drawing<E, R>,
  document: Document,
  options: Streaming.ShellOptions,
  cacheOf: CacheSource,
): Effect.Effect<string, E, Drawn<R>> =>
  Effect.map(awaitAllPage(drawing, document, options, cacheOf, Option.none()), (done) => done.html);

/** An `AwaitAll` document and what it holds. Internal: the prerender build reads it. */
export interface AwaitedPage {
  readonly html: string;
  /** The seed the document carries, stamped with `builtAt` when it was given. */
  readonly seed: ReadonlyArray<Streaming.Patch>;
  /**
   * The drawing waited for nothing when it was written. False when the time
   * limit wrote it with a query still open or a fallback still shown.
   */
  readonly complete: boolean;
}

/**
 * `awaitAllDrawing`, with the seed it wrote and whether it finished before
 * the limit. `builtAt` stamps every patch of a prerendered page (#23 §3.2):
 * the client seeds such a value stale and reads it again. Internal.
 */
export const awaitAllPage: <E, R>(
  drawing: Drawing<E, R>,
  document: Document,
  options: Streaming.ShellOptions,
  cacheOf: CacheSource,
  builtAt: Option.Option<number>,
) => Effect.Effect<AwaitedPage, E, Drawn<R>> = Effect.fn("Html.renderAwaitAll")(function* <E, R>(
  drawing: Drawing<E, R>,
  document: Document,
  options: Streaming.ShellOptions,
  cacheOf: CacheSource,
  builtAt: Option.Option<number>,
) {
  const scope = yield* Scope.make();
  const html = yield* Effect.gen(function* () {
    const cache = yield* cacheOf;
    const withCache = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
      Effect.provideService(effect, QueryCache, cache);
    // The limit runs once, from the drawing.
    const limit = yield* Deferred.make<void>();
    yield* Effect.forkIn(Effect.andThen(options.closeWhen, Deferred.succeed(limit, void 0)), scope);
    // Completed by the host after a write that can clear the last fallback.
    let changed = Deferred.makeUnsafe<void>();
    const wake = (): void => void Deferred.doneUnsafe(changed, Exit.void);
    // Setups the runtime ran after the frame, still running: a list row's
    // setup may declare a query or draw nodes when it ends.
    let setups = 0;
    const bindings = makeBindings();
    const watched = makeHost(
      wake,
      Option.some(() => {
        setups += 1;
        return () => {
          setups -= 1;
          wake();
        };
      }),
      Option.some(bindings),
    );
    // The declarations and the seed, with the drawing at the same instant.
    const records = readDrawn(
      withCache(Effect.all({ ids: Streaming.declared, seed: Streaming.settledPatches })),
      (read) => [read.ids, read.seed],
      bindings,
      limit,
    );
    const root = element("#root");
    yield* Scope.provide(draw(drawing, cache, root, watched), scope);
    let waiting = true;
    while (waiting) {
      // A fresh signal before the check, so a write after it is never missed.
      if (Deferred.isDoneUnsafe(changed)) {
        changed = Deferred.makeUnsafe<void>();
      }
      const signal = changed;
      // Read before the declarations: a setup that ends after this read
      // wakes the next pass, which reads them again.
      const settledSetups = setups === 0;
      // The catch-up draws, then the tree is read at once: a branch switch
      // it ran has taken its fallback away by now.
      const drawn = yield* records;
      const { ids, seed } = drawn.records;
      if (!drawn.agreed) {
        // The limit ended the reads: write the last pass as it is.
        return awaited(document, root, stamp(seed, builtAt), false);
      }
      const open = seed.length < ids.length;
      if (settledSetups && setups === 0 && !open && !root.children.some(waitsForData)) {
        return awaited(document, root, stamp(seed, builtAt), true);
      }
      const wakes: Array<Effect.Effect<boolean>> = [
        Effect.as(Deferred.await(signal), true),
        Effect.as(Deferred.await(limit), false),
      ];
      if (open) {
        wakes.push(Effect.as(withCache(Streaming.awaitDeclared), true));
      }
      waiting = yield* Effect.raceAll(wakes);
    }
    const { seed } = (yield* records).records;
    return awaited(document, root, stamp(seed, builtAt), false);
  }).pipe(
    Scope.provide(scope),
    Effect.onExit((exit) => Scope.close(scope, exit)),
  );
  return html;
});

/**
 * Draw once and write the document with the seed of every query that has
 * settled by then (the `SSR` mode of a routed tree). The drawing decides
 * what settles first: a routed `SSR` tree resolves its declared data before
 * its views draw. A query still open writes no seed; its boundary shows the
 * fallback on both sides, and the client reads it. `options.closeWhen`
 * ends the reads that bring the drawing to the seed's instant (see
 * `readDrawn`). Internal: see `Drawing`.
 */
export const renderSeeded: <E, R>(
  drawing: Drawing<E, R>,
  document: Document,
  options: Streaming.ShellOptions,
  cacheOf: CacheSource,
) => Effect.Effect<string, E, Drawn<R>> = Effect.fn("Html.renderSeeded")(function* <E, R>(
  drawing: Drawing<E, R>,
  document: Document,
  options: Streaming.ShellOptions,
  cacheOf: CacheSource,
) {
  const scope = yield* Scope.make();
  return yield* Effect.gen(function* () {
    const cache = yield* cacheOf;
    const root = element("#root");
    const bindings = makeBindings();
    yield* draw(
      drawing,
      cache,
      root,
      makeHost(() => {}, Option.none(), Option.some(bindings)),
    );
    const limit = yield* limitOf(options.closeWhen);
    const { records } = yield* readDrawn(
      Effect.provideService(Streaming.settledPatches, QueryCache, cache),
      (read) => read,
      bindings,
      limit,
    );
    return page(document, root, records);
  }).pipe(
    Scope.provide(scope),
    Effect.onExit((exit) => Scope.close(scope, exit)),
  );
});

const page = (
  document: Document,
  root: HtmlElement,
  seed: ReadonlyArray<Streaming.Patch>,
): string =>
  [
    document.head,
    serializeChildren(root.children),
    document.tail,
    seedScript(seed),
    document.bootstrap,
    document.end,
  ].join("");

const awaited = (
  document: Document,
  root: HtmlElement,
  seed: ReadonlyArray<Streaming.Patch>,
  complete: boolean,
): AwaitedPage => ({ html: page(document, root, seed), seed, complete });

/** Mark every patch as read at build time. None: an ordinary request. */
const stamp = (
  seed: ReadonlyArray<Streaming.Patch>,
  builtAt: Option.Option<number>,
): ReadonlyArray<Streaming.Patch> =>
  Option.match(builtAt, {
    onNone: () => seed,
    onSome: (at) => seed.map((patch): Streaming.Patch => ({ ...patch, builtAt: at })),
  });

const seedScript = (seed: ReadonlyArray<Streaming.Patch>): string => {
  if (seed.length === 0) {
    return "";
  }
  return jsonScript(Streaming.seedId, encodeSeed(seed));
};
