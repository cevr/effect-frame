import type { Source } from "effect-frame/actor";
import { Effect, Exit, Fiber, Match, Option, Predicate, Queue, Ref, Scope, Stream } from "effect";
import type { Accessor } from "@solidjs/signals";
import {
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  getOwner,
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
  ShowNode,
} from "./jsx-runtime.js";
import type { Attached, Bound, Handler, Prepared, View } from "./view.js";
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
  readonly register: (cleanup: Cleanup) => void;
  readonly owned: <A>(build: (scope: Scope.Scope) => A) => Owned<A>;
  /** Run a build with `scope` current, for work that lands after `owned` returned. */
  readonly within: <A>(scope: Scope.Scope, build: () => A) => A;
  /**
   * Run an Effect on a fiber of its own, in the context captured at mount,
   * and interrupt it when `scope` closes. The fiber starts at once: an
   * effect with no suspension completes before this returns.
   */
  readonly run: (effect: Effect.Effect<unknown>, scope: Scope.Scope) => void;
  /**
   * Turn a handler into a host callback bound to the scope current at the
   * call: the scope of the branch or row whose element is being built. The
   * fiber the callback forks is interrupted when that scope closes.
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

  return {
    createElement: host.createElement,
    createText: host.createText,
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

const makeTracker = Effect.fn("View.makeTracker")(function* () {
  const cleanups: Array<Cleanup> = [];
  const context = yield* Effect.context<Scope.Scope>();
  const mountScope = yield* Effect.scope;
  const runSync = Effect.runSyncWith(context);
  const runFork = Effect.runForkWith(context);

  // The scope a subscription forks into. `owned` swaps it for the duration of
  // one build, so a branch's subscriptions land in the branch's own scope.
  let current: Scope.Scope = mountScope;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.length = 0;
    }),
  );

  const track = <A>(source: Source<A>): Accessor<A> => {
    if (isSignalSource(source)) {
      return source[SignalBacked];
    }
    const cell = makeCell(source.get.pipe(runSync));
    runFork(
      Effect.forkIn(
        Stream.runForEach(source.changes, (value) => Effect.sync(() => cell.write(value))),
        current,
      ),
    );
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
    register: (cleanup: Cleanup) => void cleanups.push(cleanup),
    owned,
    within,
    commit,
    afterCommit: (task) => void pending.push(task),
    scope: () => current,
    run: (effect, scope) => void Fiber.runIn(runFork(effect), scope),
    handle: (handler) => {
      const scope = current;
      return (event) => void Fiber.runIn(runFork(handler(event)), scope);
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
): Build<HostNode> =>
  switchOn(tracker, host, when, (visible) => {
    if (visible) {
      return child;
    }
    return fallback;
  });

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
      Option.match(shown, { onNone: () => {}, onSome: tearDown });
      tracker.commit(() => {
        const drawn = untrack(() => build(sideFor(next)));
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
): Omit<ElementPlan<HostNode>, "tag" | "children"> => {
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

const planElement = <HostNode>(
  renderer: Renderer<HostNode>,
  element: ElementNode,
): Build<HostNode> =>
  buildElement(renderer, {
    tag: element.tag,
    ...sortProps(renderer, element),
    children: plan(renderer, element.children),
  });

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
      tracker.register(
        host.addEventListener(node, name, (event) => {
          if (prepared.preventDefault) {
            event.preventDefault();
          }
          run(event);
        }),
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
      const settled = placed.filter((key) => rows.has(key));
      let cursor = 0;
      order.forEach((key, index) => {
        const row = get(rows, key);
        if (Option.isNone(row) || row.value.slot.nodes.length === 0) {
          return;
        }
        if (Option.contains(at(settled, cursor), key)) {
          cursor += 1;
          return;
        }
        const anchor = anchorAfter(slots, index);
        for (const created of row.value.slot.nodes) {
          host.insert(parent, created, anchor);
        }
        settled.splice(settled.indexOf(key), 1);
      });
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
    const tracker = yield* makeTracker();
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
          Effect.sync(() =>
            createRoot((disposeRoot) => {
              dispose = Option.some(disposeRoot);
              tracker.commit(() => {
                plan({ host: trackedHost, tracker }, tree)(root, slot, () => {});
                flush();
              });
              return disposeRoot;
            }),
          ),
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
