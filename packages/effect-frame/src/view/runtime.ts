import type { Source } from "effect-frame/actor";
import {
  Effect,
  Equal,
  Exit,
  Match,
  Option,
  Predicate,
  Queue,
  Ref,
  Scheduler,
  Scope,
  Stream,
} from "effect";
import type { Accessor } from "@solidjs/signals";
import {
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
} from "@solidjs/signals";
import type { Cleanup, Host, HostEvent, PropertyValue, StaticProps } from "./host.js";
import type {
  ElementNode,
  ForNode,
  MatchNode,
  Node,
  PortalNode,
  PropValue,
  RetainedNode,
  ShowNode,
} from "./jsx-runtime.js";
import { repopulate } from "./form.js";
import type { Attached, Bound, Handler, PlainPost, Prepared, View } from "./view.js";
import * as Inspection from "../inspection.js";

/**
 * The mount runtime. It walks one JSX tree, resolves every explicitly bound
 * source, and then builds host nodes. Solid's graph carries an update from a
 * source to a host write; it is never a public entry point.
 */

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * Solid reads a stored function as a compute, so every value the runtime
 * holds travels boxed. One box, one rule, and a view may bind a source whose
 * value happens to be a function.
 */
interface Box<A> {
  readonly value: A;
}

interface Cell<A> {
  readonly read: Accessor<A>;
  readonly write: (value: A) => void;
}

const makeCell = <A>(initial: A): Cell<A> => {
  const [read, write] = createSignal<Box<A>>({ value: initial }, { equals: false });
  return { read: () => read().value, write: (value) => void write({ value }) };
};

// ---------------------------------------------------------------------------
// Signal-backed sources
// ---------------------------------------------------------------------------

const SignalBacked = Symbol.for("effect-frame/view/SignalBacked");

/**
 * A source whose value already lives in the reactive graph. `For` gives one
 * to each row: the row's item, updated in place when the list replaces that
 * key. The runtime reads its accessor straight from the graph.
 */
interface SignalSource<A> extends Source<A> {
  readonly [SignalBacked]: Accessor<A>;
}

/**
 * A subscriber to `changes` lives outside the reactive graph, so the effect
 * that feeds it gets an owner of its own: one root, disposed with the
 * stream's scope. Delivery runs untracked, because an offer can resume the
 * consumer fiber synchronously and that consumer may read a signal; such a
 * read is the consumer's, not this effect's.
 */
const signalSource = <A>(read: Accessor<A>): SignalSource<A> => ({
  [SignalBacked]: read,
  get: Effect.sync(read),
  changes: Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        createRoot((dispose) => {
          createRenderEffect(read, (value) => untrack(() => void Queue.offerUnsafe(queue, value)));
          return dispose;
        }),
      ),
      (dispose) => Effect.sync(dispose),
    ),
  ),
});

const isSignalSource = <A>(source: Source<A>): source is SignalSource<A> => SignalBacked in source;

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * A slot is one child position under a parent. `nodes` is the span the slot
 * currently occupies, in order, so a dynamic slot replaces only its own span
 * and leaves its siblings alone.
 */
interface Slot<HostNode> {
  nodes: ReadonlyArray<HostNode>;
}

/** Builds a slot's content under `parent`. `changed` reports a new span. */
type Build<HostNode> = (parent: HostNode, slot: Slot<HostNode>, changed: () => void) => void;

/** An index that may be out of range, and a key that may be absent. */
const at = <A>(items: ReadonlyArray<A>, index: number): Option.Option<A> =>
  Option.fromNullishOr(items[index]);

const get = <K, V>(map: ReadonlyMap<K, V>, key: K): Option.Option<V> =>
  Option.fromNullishOr(map.get(key));

/** The first node after this slot, which anchors an ordered insert. */
const anchorAfter = <HostNode>(
  slots: ReadonlyArray<Slot<HostNode>>,
  index: number,
): Option.Option<HostNode> => {
  for (let i = index + 1; i < slots.length; i += 1) {
    const first = Option.flatMap(at(slots, i), (slot) => at(slot.nodes, 0));
    if (Option.isSome(first)) {
      return first;
    }
  }
  return Option.none();
};

/**
 * The keys a reorder can leave where they are: the longest run of `wanted`
 * whose keys already sit in increasing document order in `placed`. Every
 * other key moves, so the fewest rows are touched and focus, selection,
 * and scroll survive in the rest.
 */
const inPlace = (
  wanted: ReadonlyArray<string>,
  placed: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const position = new Map(placed.map((key, index) => [key, index]));
  const keys: Array<string> = [];
  const positions: Array<number> = [];
  for (const key of wanted) {
    Option.match(get(position, key), {
      onNone: () => {},
      onSome: (index) => {
        keys.push(key);
        positions.push(index);
      },
    });
  }
  // Patience sorting: `tails[k]` holds the index of the smallest last
  // position of an increasing run of length k + 1; `previous` links runs back.
  const tails: Array<number> = [];
  const previous: Array<number> = [];
  positions.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((positions[tails[middle] ?? 0] ?? 0) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    previous[index] = tails[low - 1] ?? -1;
    tails[low] = index;
  });
  const stable = new Set<string>();
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    stable.add(keys[cursor] ?? "");
    cursor = previous[cursor] ?? -1;
  }
  return stable;
};

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** What a build produced, and the closer for the scope it was built in. */
interface Owned<A> {
  readonly value: A;
  readonly close: () => void;
}

/**
 * The tracker turns a `Source` into a reactive accessor. It is synchronous by
 * design: host nodes are built inside the Solid root, and a `For` row that
 * appears long after mount must plan its own body there.
 *
 * `track` reads the source's current value and forks its subscription into
 * whichever scope is current, through the context captured at mount. A source
 * whose `get` suspends cannot be bound, and saying so here keeps every later
 * phase free of Effects.
 *
 * `owned` runs a build under a fresh child scope and hands back the closer.
 * Whatever that build tracks is subscribed in that child, so closing it ends
 * exactly those subscriptions. A `Show` branch uses it; the mount root is the
 * scope everything else falls back to.
 */
interface Tracker {
  readonly track: <A>(source: Source<A>) => Accessor<A>;
  /**
   * The source's value now, read synchronously as `track` reads it. A value
   * `track` delivers was read on the subscription's fiber and may be older
   * than a write made since; a decision that must not act on such a value
   * reads again here.
   */
  readonly read: <A>(source: Source<A>) => A;
  /** Acquire a host resource and register its cleanup in the current scope. */
  readonly register: (acquire: () => Cleanup) => void;
  readonly owned: <A>(build: (scope: Scope.Scope) => A) => Owned<A>;
  /** Run a build with `scope` current, for work that lands after `owned` returned. */
  readonly within: <A>(scope: Scope.Scope, build: () => A) => A;
  /**
   * Run an Effect on a fiber of its own, in the context captured at mount,
   * and interrupt it when `scope` closes. The fiber starts at once: an
   * effect with no suspension completes before this returns. The scope owns
   * the fiber before the fiber starts, so a closed scope cannot start it.
   */
  readonly run: (effect: Effect.Effect<unknown>, scope: Scope.Scope) => void;
  /**
   * Turn a handler into a host callback bound to the scope current at the
   * call: the scope of the branch or row whose element is being built. The
   * scope owns the fiber before it starts, and interrupts it when that scope
   * closes.
   */
  readonly handle: (handler: Handler) => (event: HostEvent) => void;
  /**
   * Run a build and then, once the outermost build has returned and its
   * nodes are in the document, everything `afterCommit` queued during it.
   * A build inside a build (a branch planned while the mount is planned)
   * leaves the queue to the outermost, so a behaviour never sees a node
   * that is not yet in the document.
   */
  readonly commit: <A>(build: () => A) => A;
  readonly afterCommit: (task: () => void) => void;
  /** The scope current at the call: the branch or row being built. */
  readonly scope: () => Scope.Scope;
}

interface Renderer<HostNode> {
  readonly host: Host<HostNode>;
  readonly tracker: Tracker;
}

interface HostWrite<HostNode> {
  readonly parent: HostNode;
  readonly node: HostNode;
}

interface TrackedHost<HostNode> extends Host<HostNode> {
  readonly cleanup: () => void;
}

interface PresentationHost<HostNode> extends Host<HostNode> {
  readonly show: (anchor: Option.Option<HostNode>) => void;
  readonly hide: () => void;
  readonly dispose: () => void;
}

/**
 * Present content through a host without closing its owner while it is
 * hidden. Nodes made by this host can still build their detached descendants;
 * inserts into an external parent are kept as a logical child list until the
 * presentation is shown. The host is private to a retained readiness node.
 */
const presentationHost = <HostNode>(
  host: Host<HostNode>,
  initiallyVisible: boolean,
  rootParent: HostNode,
): PresentationHost<HostNode> => {
  const createDetachedElement = host.createDetachedElement ?? host.createElement;
  const createDetachedText = host.createDetachedText ?? host.createText;
  const created = new Set<HostNode>();
  const physicalParent = new Map<HostNode, HostNode>();
  const physicalChildren = new Map<HostNode, Set<HostNode>>();
  const externalParent = new Map<HostNode, HostNode>();
  const externalChildren = new Map<HostNode, Array<HostNode>>();
  const mounted = new Map<HostNode, HostNode>();
  const attachments = new Map<HostNode, Array<(node: HostNode) => void>>();
  let visible = initiallyVisible;

  const childrenOf = (parent: HostNode): Set<HostNode> => {
    const createdChildren = new Set<HostNode>();
    return Option.match(Option.fromNullishOr(physicalChildren.get(parent)), {
      onNone: () => {
        physicalChildren.set(parent, createdChildren);
        return createdChildren;
      },
      onSome: (current) => current,
    });
  };

  const rememberPhysical = (parent: HostNode, node: HostNode): void => {
    Option.match(Option.fromNullishOr(physicalParent.get(node)), {
      onNone: () => {},
      onSome: (previous) => {
        if (previous !== parent) {
          childrenOf(previous).delete(node);
        }
      },
    });
    physicalParent.set(node, parent);
    childrenOf(parent).add(node);
  };

  const forgetPhysical = (parent: HostNode, node: HostNode): void => {
    if (
      !Option.exists(
        Option.fromNullishOr(physicalParent.get(node)),
        (current) => current === parent,
      )
    ) {
      return;
    }
    physicalParent.delete(node);
    Option.match(Option.fromNullishOr(physicalChildren.get(parent)), {
      onNone: () => {},
      onSome: (children) => {
        children.delete(node);
        if (children.size === 0) {
          physicalChildren.delete(parent);
        }
      },
    });
  };

  const removeExternalChild = (parent: HostNode, node: HostNode): void => {
    Option.match(Option.fromNullishOr(externalChildren.get(parent)), {
      onNone: () => {},
      onSome: (children) => {
        const index = children.indexOf(node);
        if (index >= 0) {
          children.splice(index, 1);
        }
        if (children.length === 0) {
          externalChildren.delete(parent);
        }
      },
    });
  };

  const forgetExternal = (node: HostNode): void => {
    Option.match(Option.fromNullishOr(externalParent.get(node)), {
      onNone: () => {},
      onSome: (parent) => {
        removeExternalChild(parent, node);
        externalParent.delete(node);
      },
    });
  };

  /**
   * Forget one node when the owner that created it ends. `remove` is not this
   * signal: a nested presentation removes a live node when it hides, and the
   * node returns on reveal. The owner ending is final, so a queued
   * attachment that never saw the document is dropped here with the rest of
   * the node's bookkeeping.
   */
  const release = (node: HostNode): void => {
    Option.match(Option.fromNullishOr(mounted.get(node)), {
      onNone: () => {},
      onSome: (mountedAt) => host.remove(mountedAt, node),
    });
    forgetExternal(node);
    Option.match(Option.fromNullishOr(physicalParent.get(node)), {
      onNone: () => {},
      onSome: (parent) => forgetPhysical(parent, node),
    });
    physicalChildren.delete(node);
    mounted.delete(node);
    attachments.delete(node);
    created.delete(node);
  };

  const own = (node: HostNode): HostNode => {
    created.add(node);
    onCleanup(() => release(node));
    return node;
  };

  const rememberExternalChild = (
    parent: HostNode,
    node: HostNode,
    anchor: Option.Option<HostNode>,
  ): void => {
    Option.match(Option.fromNullishOr(externalParent.get(node)), {
      onNone: () => {},
      onSome: (previous) => {
        if (previous !== parent) {
          removeExternalChild(previous, node);
        }
      },
    });
    const children = Option.match(Option.fromNullishOr(externalChildren.get(parent)), {
      onNone: () => new Array<HostNode>(),
      onSome: (current) => current,
    });
    const currentIndex = children.indexOf(node);
    if (currentIndex >= 0) {
      children.splice(currentIndex, 1);
    }
    const anchorIndex = Option.match(anchor, {
      onNone: () => -1,
      onSome: (before) => children.indexOf(before),
    });
    if (anchorIndex >= 0) {
      children.splice(anchorIndex, 0, node);
    } else {
      children.push(node);
    }
    externalChildren.set(parent, children);
    externalParent.set(node, parent);
  };

  const removeExternal = (parent: HostNode, node: HostNode): void => {
    removeExternalChild(parent, node);
    if (
      Option.exists(Option.fromNullishOr(externalParent.get(node)), (current) => current === parent)
    ) {
      externalParent.delete(node);
    }
    if (mounted.get(node) === parent) {
      host.remove(parent, node);
      mounted.delete(node);
      forgetPhysical(parent, node);
    }
  };

  const insertExternal = (
    parent: HostNode,
    node: HostNode,
    anchor: Option.Option<HostNode>,
  ): void => {
    Option.match(Option.fromNullishOr(physicalParent.get(node)), {
      onNone: () => {},
      onSome: (previous) => {
        if (previous !== parent) {
          host.remove(previous, node);
          forgetPhysical(previous, node);
          mounted.delete(node);
        }
      },
    });
    rememberExternalChild(parent, node, anchor);
    if (!visible) {
      return;
    }
    host.insert(parent, node, anchor);
    rememberPhysical(parent, node);
    mounted.set(node, parent);
  };

  const insertCreated = (
    parent: HostNode,
    node: HostNode,
    anchor: Option.Option<HostNode>,
  ): void => {
    forgetExternal(node);
    Option.match(Option.fromNullishOr(physicalParent.get(node)), {
      onNone: () => {},
      onSome: (previous) => {
        if (previous !== parent) {
          host.remove(previous, node);
          forgetPhysical(previous, node);
          mounted.delete(node);
        }
      },
    });
    host.insert(parent, node, anchor);
    rememberPhysical(parent, node);
  };

  const runPendingAttachments = (): void => {
    const pending = [...attachments.entries()];
    for (const [node, runs] of pending) {
      if (!attachments.has(node)) {
        continue;
      }
      attachments.delete(node);
      for (const run of runs) {
        host.attach(node, run);
      }
    }
  };

  const mountChildren = (
    parent: HostNode,
    children: ReadonlyArray<HostNode>,
    anchor: Option.Option<HostNode>,
  ): void => {
    for (const node of children) {
      if (mounted.has(node)) {
        continue;
      }
      host.insert(parent, node, anchor);
      rememberPhysical(parent, node);
      mounted.set(node, parent);
    }
  };

  const show = (anchor: Option.Option<HostNode>): void => {
    if (visible) {
      return;
    }
    visible = true;
    for (const [parent, children] of externalChildren) {
      if (parent === rootParent) {
        mountChildren(parent, children, anchor);
      } else {
        mountChildren(parent, children, Option.none());
      }
    }
    runPendingAttachments();
  };

  const hide = (): void => {
    if (!visible) {
      return;
    }
    const writes = [...mounted.entries()].reverse();
    for (const [node, parent] of writes) {
      host.remove(parent, node);
      forgetPhysical(parent, node);
      mounted.delete(node);
    }
    visible = false;
  };

  const dispose = (): void => {
    hide();
    attachments.clear();
    externalParent.clear();
    externalChildren.clear();
    mounted.clear();
    physicalParent.clear();
    physicalChildren.clear();
    created.clear();
  };

  return {
    createElement: (tag, staticProps) => {
      if (visible) {
        return own(host.createElement(tag, staticProps));
      }
      return own(createDetachedElement(tag, staticProps));
    },
    createText: (text) => {
      if (visible) {
        return own(host.createText(text));
      }
      return own(createDetachedText(text));
    },
    createDetachedElement: (tag, staticProps) => own(createDetachedElement(tag, staticProps)),
    createDetachedText: (text) => own(createDetachedText(text)),
    setProperty: host.setProperty,
    insert: (parent, node, anchor) => {
      if (created.has(parent)) {
        insertCreated(parent, node, anchor);
        return;
      }
      insertExternal(parent, node, anchor);
    },
    remove: (parent, node) => {
      if (created.has(parent)) {
        host.remove(parent, node);
        forgetPhysical(parent, node);
        return;
      }
      removeExternal(parent, node);
    },
    setText: host.setText,
    addEventListener: host.addEventListener,
    attach: (node, run) => {
      if (visible) {
        host.attach(node, run);
        return;
      }
      const runs = attachments.get(node) ?? [];
      runs.push(run);
      attachments.set(node, runs);
    },
    boundaryMarks: host.boundaryMarks,
    // Hidden content was not drawn by the server, so it adopts no marks (#22).
    adoptBoundary: (shown) => visible && adoptBoundaryOf(host)(shown),
    show,
    hide,
    dispose,
  };
};

const neverAdopted = (): boolean => false;

/** The host's boundary adoption, or none: only a hydrating host adopts (#22). */
const adoptBoundaryOf = <HostNode>(host: Host<HostNode>) => host.adoptBoundary ?? neverAdopted;

/**
 * The host a boundary builds through when the server drew its other branch:
 * every node is new, so nothing below claims a server node.
 */
const detachedHost = <HostNode>(host: Host<HostNode>): Host<HostNode> => ({
  ...host,
  createElement: host.createDetachedElement ?? host.createElement,
  createText: host.createDetachedText ?? host.createText,
  adoptBoundary: neverAdopted,
});

/**
 * Keep every node this mount hands to the host. A slot is a logical view
 * position, so it can still be empty when a later sibling write fails. The
 * write ledger covers that gap and records portal parents as well as the
 * mount root. It only contains this mount's nodes, so cleanup preserves host
 * nodes owned by someone else.
 */
const trackHostWrites = <HostNode>(host: Host<HostNode>): TrackedHost<HostNode> => {
  // Map uses host-node identity, so keyed-list inserts and removals stay
  // constant time even when a mount owns a large tree.
  const writes = new Map<HostNode, HostWrite<HostNode>>();
  const children = new Map<HostNode, Set<HostNode>>();

  const rememberChild = (parent: HostNode, node: HostNode): void => {
    const current = Option.fromNullishOr(children.get(parent));
    const owned = Option.getOrElse(current, () => {
      const created = new Set<HostNode>();
      children.set(parent, created);
      return created;
    });
    owned.add(node);
  };

  const forgetChild = (parent: HostNode, node: HostNode): void => {
    Option.match(Option.fromNullishOr(children.get(parent)), {
      onNone: () => {},
      onSome: (owned) => {
        owned.delete(node);
        if (owned.size === 0) {
          children.delete(parent);
        }
      },
    });
  };

  const remember = (parent: HostNode, node: HostNode): void => {
    // Record before delegating. A host may mutate and then report an insert
    // failure, and that partial write still belongs to this mount.
    Option.match(Option.fromNullishOr(writes.get(node)), {
      onNone: () => {
        writes.set(node, { parent, node });
        rememberChild(parent, node);
      },
      onSome: (write) => {
        if (write.parent !== parent) {
          forgetChild(write.parent, node);
          writes.set(node, { parent, node });
          rememberChild(parent, node);
        }
      },
    });
  };

  const forgetSubtree = (root: HostNode): void => {
    const pending: Array<HostNode> = [root];
    while (pending.length > 0) {
      const current = Option.getOrThrow(Option.fromNullishOr(pending[pending.length - 1]));
      pending.length -= 1;
      Option.match(Option.fromNullishOr(children.get(current)), {
        onNone: () => {},
        onSome: (owned) => {
          for (const child of owned) {
            pending.push(child);
          }
          children.delete(current);
        },
      });
      Option.match(Option.fromNullishOr(writes.get(current)), {
        onNone: () => {},
        onSome: (write) => {
          forgetChild(write.parent, current);
          writes.delete(current);
        },
      });
    }
  };

  const forget = (parent: HostNode, node: HostNode): void => {
    Option.match(Option.fromNullishOr(writes.get(node)), {
      onNone: () => {},
      onSome: (write) => {
        if (write.parent === parent) {
          forgetSubtree(node);
        }
      },
    });
  };

  // A host that forgets nodes hears when each node's owner ends. Every node
  // is created inside the owner that draws it, so its cleanup is that end.
  const owned = <Args extends ReadonlyArray<unknown>>(
    create: (...args: Args) => HostNode,
  ): ((...args: Args) => HostNode) =>
    Option.match(Option.fromNullishOr(host.forget), {
      onNone: () => create,
      onSome:
        (ended) =>
        (...args: Args) => {
          const node = create(...args);
          onCleanup(() => ended(node));
          return node;
        },
    });

  return {
    createElement: owned(host.createElement),
    createText: owned(host.createText),
    createDetachedElement: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(host.createDetachedElement), owned),
    ),
    createDetachedText: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(host.createDetachedText), owned),
    ),
    boundaryMarks: host.boundaryMarks,
    adoptBoundary: host.adoptBoundary,
    setupStarted: host.setupStarted,
    sourceBound: host.sourceBound,
    setProperty: host.setProperty,
    insert: (parent, node, anchor) => {
      remember(parent, node);
      host.insert(parent, node, anchor);
    },
    remove: (parent, node) => {
      host.remove(parent, node);
      forget(parent, node);
    },
    setText: host.setText,
    addEventListener: host.addEventListener,
    attach: host.attach,
    cleanup: () => {
      for (const write of [...writes.values()].reverse()) {
        host.remove(write.parent, write.node);
      }
      writes.clear();
      children.clear();
    },
  };
};

const makeTracker = Effect.fn("View.makeTracker")(function* (
  setupStarted: Option.Option<() => () => void>,
  sourceBound: Option.Option<(catchUp: () => void) => () => void>,
) {
  const context = yield* Effect.context<Scope.Scope>();
  const mountScope = yield* Effect.scope;
  const mountScheduler = yield* Scheduler.Scheduler;
  const runSync = Effect.runSyncWith(context);
  const runFork = Effect.runForkWith(context);

  // The scope a subscription forks into. `owned` swaps it for the duration of
  // one build, so a branch's subscriptions land in the branch's own scope.
  let current: Scope.Scope = mountScope;

  const track = <A>(source: Source<A>): Accessor<A> => {
    if (isSignalSource(source)) {
      return source[SignalBacked];
    }
    let shown = source.get.pipe(runSync);
    const cell = makeCell(shown);
    const show = (value: A): void => {
      shown = value;
      cell.write(value);
    };
    runFork(
      Effect.forkIn(
        Stream.runForEach(source.changes, (value) => Effect.sync(() => show(value))),
        current,
      ),
    );
    // A host that writes the drawing beside a seed (#22) brings this binding
    // to the source's current value first: a change still on its way through
    // the fiber above is then drawn already. An equal value writes nothing.
    Option.match(sourceBound, {
      onNone: () => {},
      onSome: (bound) =>
        void runSync(
          Effect.acquireRelease(
            Effect.sync(() =>
              bound(() => {
                const now = source.get.pipe(runSync);
                if (!Equal.equals(now, shown)) {
                  show(now);
                }
              }),
            ),
            (unbind) => Effect.sync(unbind),
          ).pipe(Scope.provide(current)),
        ),
    });
    return cell.read;
  };

  const within = <A>(scope: Scope.Scope, build: () => A): A => {
    const outer = current;
    current = scope;
    const value = build();
    current = outer;
    return value;
  };

  const owned = <A>(build: (scope: Scope.Scope) => A): Owned<A> => {
    const child = Scope.forkUnsafe(current);
    const value = within(child, () => build(child));
    return { value, close: () => void runFork(Scope.close(child, Exit.void)) };
  };

  const runOwned = (effect: Effect.Effect<unknown>, scope: Scope.Scope): void => {
    // `runSync` supplies a temporary synchronous scheduler to its parent
    // fiber. Restore the mount scheduler in the child before its work yields.
    void runSync(
      Effect.forkIn(
        Effect.provideService(counted(effect, scope), Scheduler.Scheduler, mountScheduler),
        scope,
      ),
    );
  };

  // A host that counts late setups (#22) hears when each one ends: when it
  // exits, or when its scope closes first, since a fiber forked into a
  // closed scope never runs. A host that does not count pays nothing.
  const counted = (effect: Effect.Effect<unknown>, scope: Scope.Scope): Effect.Effect<unknown> =>
    Option.match(setupStarted, {
      onNone: () => effect,
      onSome: (started) => {
        const ended = started();
        let done = false;
        const end = Effect.sync(() => {
          if (!done) {
            done = true;
            ended();
          }
        });
        void runSync(Scope.addFinalizer(scope, end));
        return Effect.ensuring(effect, end);
      },
    });

  let pending: Array<() => void> = [];
  let depth = 0;
  // A build is synchronous and does not throw: a view that fails does so
  // in its setup Effect, before the tree exists. So the depth is restored
  // by plain sequence, and the queue drains only for the outermost build.
  const commit = <A>(build: () => A): A => {
    depth += 1;
    const value = build();
    depth -= 1;
    if (depth === 0) {
      const tasks = pending;
      pending = [];
      for (const task of tasks) {
        task();
      }
    }
    return value;
  };

  return {
    track,
    read: (source) => source.get.pipe(runSync),
    register: (acquire: () => Cleanup) => {
      void runSync(
        Effect.acquireRelease(Effect.sync(acquire), (cleanup) => Effect.sync(cleanup)).pipe(
          Scope.provide(current),
        ),
      );
    },
    owned,
    within,
    commit,
    afterCommit: (task) => void pending.push(task),
    scope: () => current,
    run: runOwned,
    handle: (handler) => {
      const scope = current;
      return (event) => runOwned(handler(event), scope);
    },
  } satisfies Tracker;
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * What a selector produced, rendered the way a host can apply it. A binding
 * carries whatever its projection returned, so this is where an arbitrary
 * value becomes one a host understands.
 */
const asPropertyValue = <A>(value: A): PropertyValue => {
  if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return value;
  }
  return String(value);
};

const asText = (value: PropertyValue): string => {
  if (value === false) {
    return "";
  }
  return String(value);
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Turn one JSX node into a builder. Recursion is plain and synchronous. */
const plan = <HostNode>(renderer: Renderer<HostNode>, node: Node): Build<HostNode> =>
  Match.value(node).pipe(
    Match.withReturnType<Build<HostNode>>(),
    Match.tagsExhaustive({
      Empty: () => nothing(),
      Text: (text) => staticText(renderer.host, text.text),
      Bound: (bound) => dynamicText(renderer.host, renderer.tracker.track(bound.source)),
      List: (list) =>
        sequence(
          renderer.host,
          list.children.map((child) => plan(renderer, child)),
        ),
      Element: (element) => planElement(renderer, element),
      For: (list) => planFor(renderer, list),
      // The branch is planned lazily, inside the owner that shows it, so a
      // hidden branch has tracked no source. `For` plans each row the same
      // way, for the same reason.
      Show: (branch) => planShow(renderer, branch),
      Match: (matched) => planMatch(renderer, matched),
      Portal: (portal) => planPortal(renderer, portal),
      Retained: (retained) => planRetained(renderer, retained),
    }),
  );

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const nothing =
  <HostNode>(): Build<HostNode> =>
  () => {};

const staticText =
  <HostNode>(host: Host<HostNode>, text: string): Build<HostNode> =>
  (parent, slot) => {
    const node = host.createText(text);
    slot.nodes = [node];
    host.insert(parent, node, Option.none());
  };

const dynamicText =
  <HostNode>(host: Host<HostNode>, accessor: Accessor<unknown>): Build<HostNode> =>
  (parent, slot) => {
    const read = (): string => asText(asPropertyValue(accessor()));
    const node = host.createText(read());
    slot.nodes = [node];
    host.insert(parent, node, Option.none());
    createRenderEffect(read, (text) => host.setText(node, text), { defer: true });
  };

const sequence =
  <HostNode>(host: Host<HostNode>, builds: ReadonlyArray<Build<HostNode>>): Build<HostNode> =>
  (parent, slot, changed) => {
    const slots: ReadonlyArray<Slot<HostNode>> = builds.map(() => ({ nodes: [] }));
    const sync = (): void => {
      slot.nodes = slots.flatMap((child) => child.nodes);
      changed();
    };
    builds.forEach((build, index) => {
      Option.match(at(slots, index), {
        onNone: () => {},
        onSome: (child) =>
          build(parent, child, () => {
            const anchor = anchorAfter(slots, index);
            for (const created of child.nodes) {
              host.insert(parent, created, anchor);
            }
            sync();
          }),
      });
    });
    sync();
  };

/**
 * The branch and its fallback are planned lazily, each inside the owner
 * that shows it, so a hidden side has tracked no source. The branch's body
 * receives the tested value as a signal-backed source, read straight from
 * the graph, which is what lets a narrowed reading of it be honest: the
 * source is only ever read while the test holds.
 */
const planShow = <HostNode, A>(
  renderer: Renderer<HostNode>,
  branch: ShowNode<A>,
): Build<HostNode> => {
  const value = renderer.tracker.track(branch.when);
  return show(
    renderer.tracker,
    renderer.host,
    () => branch.test(value()),
    () => plan(renderer, branch.render(signalSource(value))),
    () => plan(renderer, branch.fallback),
  );
};

/** Each value in a new box, so an effect over it runs on every write. */
const boxed = <A>(source: Source<A>): Source<Box<A>> => ({
  get: Effect.map(source.get, (value) => ({ value })),
  changes: Stream.map(source.changes, (value) => ({ value })),
});

/**
 * A readiness boundary starts its content owner once and only switches the
 * presented host writes. The fallback uses the ordinary destructive branch
 * machinery, so a fallback's own resources still end when content appears.
 */
const planRetained = <HostNode>(
  renderer: Renderer<HostNode>,
  node: RetainedNode,
): Build<HostNode> => {
  const wanted = renderer.tracker.track(boxed(node.when));
  const visible = (): boolean => wanted().value;
  return (parent, slot, changed) => {
    const contentSlot: Slot<HostNode> = { nodes: [] };
    // Hydrating a streamed document (#22): the server may have drawn the
    // other branch here. Then both branches build fresh nodes.
    let branchHost = renderer.host;
    if (adoptBoundaryOf(renderer.host)(visible())) {
      branchHost = detachedHost(renderer.host);
    }
    const branchRenderer: Renderer<HostNode> = { host: branchHost, tracker: renderer.tracker };
    const presentation = presentationHost(branchHost, visible(), parent);
    const contentRenderer: Renderer<HostNode> = {
      host: presentation,
      tracker: renderer.tracker,
    };
    let presented = visible();
    const [fallbackVisible, setFallbackVisible] = createSignal(!presented);
    let hideAfterFallback = false;
    // The place mark a synchronous hold left for the fallback, until it lands.
    let held = Option.none<HostNode>();
    const releaseHeld = (): void => {
      Option.map(held, (mark) => renderer.host.remove(parent, mark));
      held = Option.none();
    };
    renderer.tracker.register(() => releaseHeld);

    // Server HTML (#22): a comment pair around the boundary's nodes, so a
    // hydrating client finds this boundary by its own pair.
    const marks = Option.map(Option.fromNullishOr(renderer.host.boundaryMarks), (make) =>
      make(node.kind),
    );
    let closeAnchor = Option.none<HostNode>();
    const wrap = (nodes: ReadonlyArray<HostNode>): ReadonlyArray<HostNode> =>
      Option.match(marks, {
        onNone: () => nodes,
        onSome: (pair) => [pair.open, ...nodes, pair.close],
      });
    const shownNodes = (): ReadonlyArray<HostNode> => {
      if (presented) {
        return wrap(contentSlot.nodes);
      }
      return wrap(fallbackSlot.nodes);
    };
    Option.map(marks, (pair) => {
      pair.show(presented);
      renderer.host.insert(parent, pair.open, Option.none());
    });

    const fallbackSlot: Slot<HostNode> = { nodes: [] };
    const fallback = show(
      renderer.tracker,
      branchHost,
      fallbackVisible,
      () => plan(branchRenderer, node.fallback),
      () => nothing(),
      () =>
        Option.orElse(
          Option.orElse(held, () => Option.fromNullishOr(contentSlot.nodes[0])),
          () => closeAnchor,
        ),
      () => {
        releaseHeld();
        if (!hideAfterFallback) {
          return;
        }
        hideAfterFallback = false;
        presentation.hide();
        slot.nodes = shownNodes();
        changed();
      },
    );
    fallback(parent, fallbackSlot, () => {
      // The fallback was drawn or taken away: the switch is complete, so the
      // marks name the branch that stands between them now.
      Option.map(marks, (pair) => pair.show(!untrack(fallbackVisible)));
      if (!presented) {
        slot.nodes = shownNodes();
        changed();
      }
    });

    const contentChanged = (): void => {
      if (presented) {
        slot.nodes = shownNodes();
        changed();
      }
    };

    const contentOwner = renderer.tracker.owned(() =>
      createRoot((disposeContent) => {
        renderer.tracker.register(() => presentation.dispose);
        untrack(() => plan(contentRenderer, node.content)(parent, contentSlot, contentChanged));
        return disposeContent;
      }),
    );
    renderer.tracker.register(() => contentOwner.close);
    Option.map(marks, (pair) => {
      renderer.host.insert(parent, pair.close, Option.none());
      closeAnchor = Option.some(pair.close);
    });
    slot.nodes = shownNodes();

    const apply = (next: boolean): void => {
      if (next === presented) {
        return;
      }
      presented = next;
      if (presented) {
        presentation.show(
          Option.orElse(Option.fromNullishOr(fallbackSlot.nodes[0]), () => closeAnchor),
        );
        setFallbackVisible(false);
        slot.nodes = shownNodes();
      } else {
        hideAfterFallback = true;
        setFallbackVisible(true);
        slot.nodes = shownNodes();
      }
      changed();
    };

    apply(presented);
    // A registration that arrives unsettled while the content is on screen
    // (#16): leave the document now, before the registering row writes a
    // node, and let the fallback follow. `when` brings the content back.
    Option.map(Option.fromNullishOr(node.hold), (subscribe) =>
      renderer.tracker.register(() =>
        subscribe(() => {
          if (!presented) {
            return;
          }
          // An empty text node keeps the content's place for the fallback,
          // which is drawn at the next flush, after the row has been built.
          const mark = renderer.host.createText("");
          renderer.host.insert(parent, mark, Option.fromNullishOr(contentSlot.nodes[0]));
          held = Option.some(mark);
          presentation.hide();
          apply(false);
        }),
      ),
    );
    // Every value of `when` arrives in a new box, so a value equal to the
    // last one the effect saw still runs `apply`: after the hold above hid
    // the content, `when` may go false and back to true before a flush.
    // A delivered value only wakes the boundary; it applies `when` as it is
    // now. A value read on the subscription's fiber before a late
    // registration held the content would otherwise bring it back while
    // that registration is still pending.
    createRenderEffect(wanted, () => apply(renderer.tracker.read(node.when)), { defer: true });
  };
};

/**
 * A branch that is currently drawn: the span it occupies and the reactive
 * owner that keeps it live. Hidden is the absence of one, so there is no
 * state describing a branch that has nodes but no owner, or the reverse.
 */
interface Branch<HostNode> {
  readonly slot: Slot<HostNode>;
  readonly dispose: () => void;
}

/**
 * A branch exists only while it is shown. Showing plans and builds it inside
 * its own reactive owner, exactly as a `For` row is built; hiding disposes
 * that owner and removes the span it holds. The branch's own slot is the
 * single record of what it owns, so a nested `Show` that reveals content
 * underneath this one reports upward through `changed` and this slot stays
 * true. Nothing survives a hide: a hidden branch holds no host node, keeps no
 * source subscribed, and runs no binding.
 */
const show = <HostNode>(
  tracker: Tracker,
  host: Host<HostNode>,
  when: Accessor<boolean>,
  child: () => Build<HostNode>,
  fallback: () => Build<HostNode>,
  before?: () => Option.Option<HostNode>,
  afterBuild?: () => void,
): Build<HostNode> =>
  switchOn(
    tracker,
    host,
    when,
    (visible) => {
      if (visible) {
        return child;
      }
      return fallback;
    },
    before,
    afterBuild,
  );

/**
 * `Match` is the same switch over a tag. The case's body reads the matched
 * value as a signal-backed source, as a `Show` branch does, and the source
 * is only ever read while its tag holds.
 */
const planMatch = <HostNode, A>(
  renderer: Renderer<HostNode>,
  node: MatchNode<A>,
): Build<HostNode> => {
  const value = renderer.tracker.track(node.on);
  return switchOn(
    renderer.tracker,
    renderer.host,
    () => node.key(value()),
    (tag) => () => plan(renderer, node.render(tag, signalSource(value))),
  );
};

/**
 * One drawn side at a time, chosen by a key. A `Show` keys on a boolean and
 * a `Match` on a tag; the switch neither knows nor cares. A key that repeats
 * is not a change, so the drawn side updates in place through its own
 * bindings and is never rebuilt.
 */
const switchOn =
  <HostNode, Key>(
    tracker: Tracker,
    host: Host<HostNode>,
    key: Accessor<Key>,
    sideFor: (key: Key) => () => Build<HostNode>,
    before?: () => Option.Option<HostNode>,
    afterBuild?: () => void,
  ): Build<HostNode> =>
  (parent, slot, changed) => {
    let shown: Option.Option<Branch<HostNode>> = Option.none();

    const build = (side: () => Build<HostNode>): Branch<HostNode> => {
      const inner: Slot<HostNode> = { nodes: [] };
      // One reactive owner and one Effect scope per shown branch: the render
      // effects live in the first, the source subscriptions in the second.
      // Building reads every source it binds, for the first value. Those
      // reads are deliberate and do not subscribe this branch's `when`
      // effect to them, so the build runs untracked.
      const branchOwner = tracker.owned(() =>
        createRoot((disposeBranch) => {
          untrack(() =>
            side()(parent, inner, () => {
              slot.nodes = inner.nodes;
              changed();
            }),
          );
          return disposeBranch;
        }),
      );
      return {
        slot: inner,
        dispose: () => {
          branchOwner.value();
          branchOwner.close();
        },
      };
    };

    const tearDown = (drawn: Branch<HostNode>): void => {
      drawn.dispose();
      for (const node of drawn.slot.nodes) {
        host.remove(parent, node);
      }
    };

    let current: Option.Option<Key> = Option.none();

    const apply = (next: Key): void => {
      if (Option.contains(current, next)) {
        return;
      }
      const anchor = before?.() ?? Option.none();
      tracker.commit(() => {
        const drawn = untrack(() => build(sideFor(next)));
        Option.match(anchor, {
          onNone: () => {},
          onSome: (beforeNode) => {
            for (const node of drawn.slot.nodes) {
              host.insert(parent, node, Option.some(beforeNode));
            }
          },
        });
        afterBuild?.();
        Option.match(shown, { onNone: () => {}, onSome: tearDown });
        shown = Option.some(drawn);
        current = Option.some(next);
        slot.nodes = drawn.slot.nodes;
        changed();
      });
    };

    apply(key());
    createRenderEffect(key, apply, { defer: true });
  };

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const isEventProp = (name: string): boolean => name.length > 2 && name.startsWith("on");

const eventNameOf = (name: string): string => `${name.slice(2, 3).toLowerCase()}${name.slice(3)}`;

interface ElementPlan<HostNode> {
  readonly tag: string;
  readonly staticProps: StaticProps;
  readonly dynamic: ReadonlyArray<readonly [string, Accessor<unknown>]>;
  readonly events: ReadonlyArray<readonly [string, Prepared]>;
  readonly attachments: ReadonlyArray<Attached<HostNode>>;
  /** A command form's hidden inputs, drawn before its own children (#21). */
  readonly hidden: ReadonlyArray<readonly [name: string, value: string]>;
  readonly children: Build<HostNode>;
}

type RawProp = NonNullable<ElementNode["props"][string]>;

/**
 * The one place a raw JSX prop becomes a kind the runtime understands. A
 * marker object keeps its identity; everything else is a static value the
 * host applies once.
 */
/**
 * A prop that carries a marker the runtime owns, rather than a value the host
 * applies. Composed from `isTagged` so a new marker tag is one more clause.
 */
const isMarker = (value: RawProp): value is Bound<unknown> | Prepared | Attached<unknown> =>
  Predicate.or(
    Predicate.or(Predicate.isTagged("Bound"), Predicate.isTagged("Prepared")),
    Predicate.isTagged("Attached"),
  )(value);

/** `attach` takes one behaviour or a list; a list composes them in order. */
const attachmentsOf = <HostNode>(raw: RawProp): ReadonlyArray<Attached<HostNode>> => {
  const one = (value: RawProp): ReadonlyArray<Attached<HostNode>> => {
    if (Predicate.isTagged("Attached")(value)) {
      return [value];
    }
    return [];
  };
  if (Array.isArray(raw)) {
    return raw.flatMap(one);
  }
  return one(raw);
};

const classify = (value: RawProp): PropValue => {
  if (Array.isArray(value)) {
    return { _tag: "Static", value: asPropertyValue(value) };
  }
  if (isMarker(value)) {
    return value;
  }
  return { _tag: "Static", value: asPropertyValue(value) };
};

/** Sort one element's props into the three kinds a host can apply. */
const sortProps = <HostNode>(
  renderer: Renderer<HostNode>,
  element: ElementNode,
): Omit<ElementPlan<HostNode>, "tag" | "children" | "hidden"> => {
  const staticProps: Record<string, PropertyValue> = {};
  const dynamic: Array<readonly [string, Accessor<unknown>]> = [];
  const events: Array<readonly [string, Prepared]> = [];
  let attachments: ReadonlyArray<Attached<HostNode>> = [];

  for (const [name, raw] of Object.entries(element.props)) {
    const present = Option.fromNullishOr(raw);
    if (name === "children" || Option.isNone(present)) {
      continue;
    }
    if (name === "attach") {
      attachments = attachmentsOf(present.value);
      continue;
    }
    const prop = classify(present.value);
    if (prop._tag === "Prepared" && isEventProp(name)) {
      events.push([eventNameOf(name), prop]);
    } else if (prop._tag === "Bound") {
      dynamic.push([name, renderer.tracker.track(prop.source)]);
    } else if (prop._tag === "Static") {
      staticProps[name] = prop.value;
    }
  }

  return { staticProps, dynamic, events, attachments };
};

/**
 * The plain post a command form carries on one of its event props. It is
 * applied the same way in every host, so the server's markup and the
 * hydrating client's nodes agree node for node.
 */
const plainPostOf = (element: ElementNode): Option.Option<PlainPost> => {
  for (const [name, raw] of Object.entries(element.props)) {
    if (isEventProp(name) && isPrepared(raw) && Option.isSome(raw.post)) {
      return raw.post;
    }
  }
  return Option.none();
};

const isPrepared = (value: RawProp): value is Prepared => Predicate.isTagged("Prepared")(value);

const planElement = <HostNode>(
  renderer: Renderer<HostNode>,
  element: ElementNode,
): Build<HostNode> => {
  const sorted = sortProps(renderer, element);
  return Option.match(plainPostOf(element), {
    onNone: () =>
      buildElement(renderer, {
        tag: element.tag,
        ...sorted,
        hidden: [],
        children: plan(renderer, element.children),
      }),
    onSome: (post) =>
      buildElement(renderer, {
        tag: element.tag,
        ...sorted,
        staticProps: { ...sorted.staticProps, method: post.method, action: post.action },
        hidden: post.hidden,
        children: plan(renderer, repopulate(element.children, post)),
      }),
  });
};

const buildElement =
  <HostNode>(renderer: Renderer<HostNode>, element: ElementPlan<HostNode>): Build<HostNode> =>
  (parent, slot) => {
    const { host, tracker } = renderer;
    const node = host.createElement(element.tag, element.staticProps);
    for (const [name, accessor] of element.dynamic) {
      const read = (): PropertyValue => asPropertyValue(accessor());
      host.setProperty(node, name, read());
      createRenderEffect(read, (value) => host.setProperty(node, name, value), { defer: true });
    }
    for (const [name, prepared] of element.events) {
      const run = tracker.handle(prepared.handler);
      tracker.register(() =>
        host.addEventListener(node, name, (event) => {
          if (prepared.preventDefault) {
            event.preventDefault();
          }
          run(event);
        }),
      );
    }
    for (const [name, value] of element.hidden) {
      host.insert(
        node,
        host.createElement("input", { type: "hidden", name, value }),
        Option.none(),
      );
    }
    element.children(node, { nodes: [] }, () => {});
    slot.nodes = [node];
    host.insert(parent, node, Option.none());
    // Behaviours run once the outermost build has put the node in the
    // document, in the scope of the branch or row being built, so each
    // ends when the element leaves.
    if (element.attachments.length > 0) {
      const scope = tracker.scope();
      tracker.afterCommit(() =>
        host.attach(node, (live) => {
          for (const attached of element.attachments) {
            tracker.run(Scope.provide(attached.run(live), scope), scope);
          }
        }),
      );
    }
  };

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

/**
 * The children build under `into` instead of the parent, with a slot of
 * their own, and the portal reports no nodes to its parent. They leave
 * with the scope that built them: a finalizer on the current scope removes
 * them from `into`, since the parent's teardown would not find them.
 */
const planPortal = <HostNode>(
  renderer: Renderer<HostNode>,
  portal: PortalNode,
): Build<HostNode> => {
  const children = plan(renderer, portal.children);
  return () => {
    const { host, tracker } = renderer;
    const inner: Slot<HostNode> = { nodes: [] };
    // oxlint-disable-next-line effect/noAs -- the tree holds a host node it cannot type
    const into = portal.into as HostNode;
    children(into, inner, () => {});
    const scope = tracker.scope();
    tracker.run(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          for (const node of inner.nodes) {
            host.remove(into, node);
          }
          inner.nodes = [];
        }),
      ),
      scope,
    );
  };
};

// ---------------------------------------------------------------------------
// For
// ---------------------------------------------------------------------------

interface Row<HostNode, Item> {
  readonly slot: Slot<HostNode>;
  readonly set: (item: Item) => void;
  readonly dispose: () => void;
}

/**
 * A keyed list. Each row owns a cell holding its item and receives that cell
 * as a read-only `Source`, so replacing an item under the same key updates
 * the row in place and keeps its host nodes. Every row plans its own body,
 * inside its own reactive owner, so a row created long after mount builds
 * exactly like the first one.
 *
 * A row's body comes from an Effect run in the row's scope. A setup that
 * completes at once builds its nodes before `createRow` returns, so the
 * list is whole when the mount returns; one that suspends builds when it
 * lands, under the row's own owner and scope, and then reorders the list so
 * the late row takes its place. The row's scope closing interrupts a setup
 * still in flight.
 */
const planFor = <HostNode, Item>(
  renderer: Renderer<HostNode>,
  node: ForNode<Item>,
): Build<HostNode> => buildFor(renderer, node, renderer.tracker.track(node.each));

const buildFor =
  <HostNode, Item>(
    renderer: Renderer<HostNode>,
    node: ForNode<Item>,
    items: Accessor<ReadonlyArray<Item>>,
  ): Build<HostNode> =>
  (parent, slot, changed) => {
    const { host, tracker } = renderer;
    const rows = new Map<string, Row<HostNode, Item>>();
    let order: ReadonlyArray<string> = [];

    /**
     * Keys whose nodes are in the document, in document order. A row's
     * nodes land at the end when its body builds; `reorder` then moves
     * only the rows that are out of place, walking the wanted order
     * against this one, so a change that keeps a row where it was never
     * touches its nodes: focus, selection, and scroll inside it survive.
     */
    let placed: Array<string> = [];

    const createRow = (key: string, item: Item): Row<HostNode, Item> => {
      const rowSlot: Slot<HostNode> = { nodes: [] };
      const cell = makeCell(item);
      let built = false;
      let late = false;
      // One reactive owner and one Effect scope per row, as for a `Show`
      // branch: whatever the row's body subscribes to ends with the row.
      const rowOwner = tracker.owned((scope) =>
        createRoot((disposeRow) => {
          const owner = getOwner();
          const build = (tree: Node): void =>
            tracker.within(scope, () =>
              runWithOwner(owner, () => {
                // Untracked for the reason a `Show` branch is: the build's
                // reads are first values, not dependencies of the list's own
                // effect.
                tracker.commit(() => {
                  untrack(() => plan(renderer, tree)(parent, rowSlot, () => {}));
                  built = true;
                  placed.push(key);
                  if (late) {
                    reorder();
                  }
                });
              }),
            );
          tracker.run(
            Effect.map(Scope.provide(node.setup(signalSource(cell.read)), scope), build),
            scope,
          );
          late = !built;
          return disposeRow;
        }),
      );
      return {
        slot: rowSlot,
        set: cell.write,
        dispose: () => {
          rowOwner.value();
          rowOwner.close();
        },
      };
    };

    const reorder = (): void => {
      const slots = order.flatMap((key) =>
        Option.match(get(rows, key), { onNone: () => [], onSome: (row) => [row.slot] }),
      );
      const stable = inPlace(order, placed);
      // Walk backwards so every anchor is a row already in its final place:
      // a forward walk can anchor on a row that moves later.
      for (let index = order.length - 1; index >= 0; index -= 1) {
        const key = order[index] ?? "";
        const row = get(rows, key);
        if (Option.isNone(row) || row.value.slot.nodes.length === 0 || stable.has(key)) {
          continue;
        }
        const anchor = anchorAfter(slots, index);
        for (const created of row.value.slot.nodes) {
          host.insert(parent, created, anchor);
        }
      }
      placed = order.filter((key) =>
        Option.match(get(rows, key), {
          onNone: () => false,
          onSome: (row) => row.slot.nodes.length > 0,
        }),
      );
      slot.nodes = slots.flatMap((child) => child.nodes);
      changed();
    };

    const apply = (next: ReadonlyArray<Item>): void => {
      const keys = next.map(node.keyBy);
      const wanted = new Set(keys);
      for (const [key, row] of rows) {
        if (!wanted.has(key)) {
          for (const created of row.slot.nodes) {
            host.remove(parent, created);
          }
          row.dispose();
          rows.delete(key);
          placed = placed.filter((kept) => kept !== key);
        }
      }
      next.forEach((item, index) => {
        Option.match(at(keys, index), {
          onNone: () => {},
          onSome: (key) =>
            Option.match(get(rows, key), {
              onNone: () =>
                void rows.set(
                  key,
                  untrack(() => createRow(key, item)),
                ),
              onSome: (row) => row.set(item),
            }),
        });
      });
      order = keys;
      reorder();
    };

    apply(items());
    createRenderEffect(items, apply, { defer: true });
  };

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mount one view on a host. The Scope owns everything: the view's setup
 * resources, the forked source subscriptions, the reactive root, and the host
 * nodes. Closing it runs every Effect finalizer and then removes the nodes.
 */
export const mount = Effect.fn("View.mount")(function* <Props, E, R, HostNode>(
  view: View<Props, E, R>,
  props: Props,
  host: Host<HostNode>,
  root: HostNode,
) {
  const callerScope = yield* Effect.scope;
  const mountScope = yield* Scope.fork(callerScope);
  const trackedHost = trackHostWrites(host);
  const registry = yield* Effect.serviceOption(Inspection.Registry);
  let owner = Option.none<Inspection.OwnerToken>();
  if (Option.isSome(registry)) {
    owner = Option.some(yield* Inspection.ownerFor(registry.value));
  }

  const run = Effect.gen(function* () {
    const phase = yield* Ref.make<"entering" | "mounted">("entering");
    if (Option.isSome(registry) && Option.isSome(owner)) {
      yield* registry.value.register(owner.value, (id) =>
        Effect.map(Ref.get(phase), (mountedPhase) => ({
          _tag: "Mount",
          id,
          ownerId: owner.value.id,
          parentOwnerId: owner.value.parentId,
          phase: mountedPhase,
        })),
      );
    }

    const tree: Node = yield* view(props);
    const tracker = yield* makeTracker(
      Option.fromNullishOr(trackedHost.setupStarted),
      Option.fromNullishOr(trackedHost.sourceBound),
    );
    const slot: Slot<HostNode> = { nodes: [] };
    const removeNodes = (): void => {
      trackedHost.cleanup();
      slot.nodes = [];
    };

    // Planning creates the signals a binding writes to, so it belongs inside
    // the root that owns them. The acquire/release pair owns the Solid root
    // before phase changes can yield. If planning defects after host writes,
    // capture the defect as an Exit, close the root, and remove those writes
    // before re-failing the acquire effect.
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        let dispose: Option.Option<() => void> = Option.none();
        const outcome = yield* Effect.exit(
          Effect.sync(() => {
            flush();
            return createRoot((disposeRoot) => {
              dispose = Option.some(disposeRoot);
              tracker.commit(() => {
                plan({ host: trackedHost, tracker }, tree)(root, slot, () => {});
                flush();
              });
              return disposeRoot;
            });
          }),
        );
        return yield* Exit.match(outcome, {
          onFailure: (cause) =>
            Effect.andThen(
              Effect.sync(() => {
                Option.match(dispose, {
                  onNone: () => {},
                  onSome: (close) => close(),
                });
                removeNodes();
              }),
              Effect.failCause(cause),
            ),
          onSuccess: (close) => Effect.succeed(close),
        });
      }),
      (close) =>
        Effect.sync(() => {
          close();
          removeNodes();
        }),
    );

    yield* Ref.set(phase, "mounted");
  });

  const ownedRun = Option.match(owner, {
    onNone: () => run,
    onSome: (value) => Effect.provideService(run, Inspection.Owner, value),
  });
  const outcome = yield* Effect.exit(
    Scope.provide(ownedRun, mountScope).pipe(
      Effect.onExit((exit) =>
        Exit.match(exit, {
          onFailure: (cause) => Scope.close(mountScope, Exit.failCause(cause)),
          onSuccess: () => Effect.void,
        }),
      ),
    ),
  );
  return yield* Exit.match(outcome, {
    onFailure: (cause) => Effect.failCause(cause),
    onSuccess: () => Effect.void,
  });
});

/**
 * Flush reactive writes that have already reached Solid. Source delivery and
 * other asynchronous work may still be pending; use an observed host
 * condition or an explicit domain signal when a test needs completion.
 */
export const render: Effect.Effect<void> = Effect.sync(flush);
