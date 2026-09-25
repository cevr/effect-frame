import { ActorTransport } from "effect-frame/actor/client";
import type { Address, AnyContract, KeyOf, Projection } from "effect-frame/actor/client";
import {
  Deferred,
  Effect,
  Exit,
  Hash,
  Match,
  Option,
  Order,
  Schema,
  SchemaTransformation,
  Scope,
  Stream,
} from "effect";
import { driveOnly, sendsNothing } from "../drive-transport.js";
import type { Cleanup, EventHandler, Host, PropertyValue, StaticProps } from "../host.js";
import { flush, mount } from "../runtime.js";
import type { View } from "../view.js";

/**
 * The streamed host-operation wire (#15), and reconnect over it (#27).
 *
 * A server-driven view mounts on a `Recorder`: a `Host` that writes each of
 * its operations as a value instead of touching a tree. The runtime never
 * learns the host is remote. A client replays the values against any real
 * host, and sends events back by the listener id the recorder gave them.
 *
 * A reconnect sends the drive actor's snapshot, never an op log. The client
 * draws the view from that snapshot on a recorder of its own, which gives the
 * same ids the server's fresh recorder gives, because a view's drawing is a
 * function of its snapshot. See `docs/design/op-wire.md`.
 *
 * The precondition: a server-driven view's drawing is a function of its props
 * and its drive actor's snapshot, and nothing else. A view that reads the
 * clock, a random number, or a service the two sides hold differently breaks
 * it. The resume payload carries a digest of the server's drawing, and a
 * client whose own drawing differs fails with `Diverged` and applies nothing.
 *
 * Patches are trusted server output, as a view's own properties are on the
 * DOM host. A client checks each patch's shape, session, position, and ids;
 * it does not sanitize property names or values.
 *
 * This module is safe for a browser. The server half is `driven.server.ts`.
 */

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

/**
 * A node on the recording side is only the id the client will use. The
 * runtime passes these values back to the host and reads nothing from them.
 */
export interface RemoteNode {
  readonly id: number;
}

/** The mount root. Its id is 0 on both sides; every other id counts from 1. */
export const root: RemoteNode = { id: 0 };

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

const NodeId = Schema.Int;

/**
 * The numbers JSON cannot carry: `NaN`, the two infinities, and `-0`, which
 * JSON writes as `0`. A view may bind any of them, and the DOM host receives
 * it as it is, so the wire carries each exactly, as a tagged object that no
 * string or finite number can be mistaken for.
 */
const Unwritable = Schema.Literals(["NaN", "Infinity", "-Infinity", "-0"]);
type Unwritable = Schema.Schema.Type<typeof Unwritable>;

/** The name an unwritable number travels under. `-0` is the one left. */
const unwritableName = (value: number): Unwritable => {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }
  return "-0";
};

const isUnwritable = (value: number): boolean => !Number.isFinite(value) || Object.is(value, -0);

const UnwritableNumber = Schema.Struct({ number: Unwritable }).pipe(
  Schema.decodeTo(
    // Only the non-finite numbers and -0 decode here; finite ones are `Schema.Finite`.
    // @effect-diagnostics-next-line schemaNumber:off
    Schema.Number.check(Schema.makeFilter(isUnwritable)),
    SchemaTransformation.transform({
      decode: (encoded: { readonly number: Unwritable }) => Number(encoded.number),
      encode: (value: number) => ({ number: unwritableName(value) }),
    }),
  ),
);

/** Every value a host property can take, `PropertyValue`, exactly. */
const Value = Schema.Union([Schema.String, Schema.Boolean, UnwritableNumber, Schema.Finite]);

export const CreateElement = Schema.TaggedStruct("CreateElement", {
  node: NodeId,
  tag: Schema.String,
  props: Schema.Array(Schema.Tuple([Schema.String, Value])),
});

export const CreateText = Schema.TaggedStruct("CreateText", {
  node: NodeId,
  text: Schema.String,
});

export const SetProperty = Schema.TaggedStruct("SetProperty", {
  node: NodeId,
  name: Schema.String,
  value: Value,
});

/** `anchor` is absent on the wire when the node goes last. */
export const Insert = Schema.TaggedStruct("Insert", {
  parent: NodeId,
  node: NodeId,
  anchor: Schema.OptionFromOptionalKey(NodeId),
});

export const Remove = Schema.TaggedStruct("Remove", { parent: NodeId, node: NodeId });

export const SetText = Schema.TaggedStruct("SetText", { node: NodeId, text: Schema.String });

/** `listener` is the id the client sends back when the event fires. */
export const AddListener = Schema.TaggedStruct("AddListener", {
  node: NodeId,
  name: Schema.String,
  listener: NodeId,
});

export const RemoveListener = Schema.TaggedStruct("RemoveListener", { listener: NodeId });

/**
 * The owner that created the node ended, so no later operation names it. The
 * client forgets the id. A removed node is not forgotten: a retained branch
 * removes its nodes when it hides and inserts them again when it shows.
 */
export const Forget = Schema.TaggedStruct("Forget", { node: NodeId });

/** One host operation. One variant per operation, with ids where nodes were. */
export const Op = Schema.Union([
  CreateElement,
  CreateText,
  SetProperty,
  Insert,
  Remove,
  SetText,
  AddListener,
  RemoveListener,
  Forget,
]);
export type Op = Schema.Schema.Type<typeof Op>;

/**
 * One frame of the wire. A client that holds position `from` may apply it,
 * and then holds `to`. Positions count the frames of one session from 0, the
 * drawing the resume payload gives. A client at any other position is
 * refused with `StaleClient`. `session` names the session that cut the
 * patch; a client that resumed from another session refuses it with
 * `ForeignSession`, because every session counts from 0.
 */
export const Patch = Schema.Struct({
  session: Schema.String,
  from: NodeId,
  to: NodeId,
  ops: Schema.Array(Op),
});
export type Patch = Schema.Schema.Type<typeof Patch>;

/** An event travelling back: the listener id and the event's value. */
export const RemoteEvent = Schema.Struct({
  listener: NodeId,
  value: Schema.String,
});
export type RemoteEvent = Schema.Schema.Type<typeof RemoteEvent>;

/** A patch as it travels: one JSON string. */
export const PatchJson = Schema.fromJsonString(Patch);

/** An event as it travels: one JSON string. */
export const RemoteEventJson = Schema.fromJsonString(RemoteEvent);

/** A patch whose `from` is not the position the client holds. Nothing was applied. */
export class StaleClient extends Schema.TaggedError<StaleClient>()("StaleClient", {
  held: NodeId,
  wanted: NodeId,
}) {}

/**
 * A patch from a session other than the one the client resumed from. Nothing
 * was applied. `held` is absent before the first resume.
 */
export class ForeignSession extends Schema.TaggedError<ForeignSession>()("ForeignSession", {
  held: Schema.Option(Schema.String),
  sent: Schema.String,
}) {}

/**
 * The client's drawing from the snapshot is not the drawing the server made
 * from it: the view read something besides its props and its drive's
 * snapshot. Nothing was applied, and the client keeps the tree it held. No
 * patch can repair this; the page must be drawn again from markup.
 */
export class Diverged extends Schema.TaggedError<Diverged>()("Diverged", {
  expected: Schema.String,
  drawn: Schema.String,
}) {}

/**
 * A patch names a node or listener the client does not hold. Nothing was
 * applied. Only a recorder whose ids drifted from the client's can send one.
 */
export class UnknownNode extends Schema.TaggedError<UnknownNode>()("UnknownNode", {
  node: NodeId,
}) {}

// ---------------------------------------------------------------------------
// The shadow
// ---------------------------------------------------------------------------

/**
 * The recorder's copy of the tree the client holds, so an operation that
 * would not change it is never sent. The runtime is tuned for a host that
 * absorbs redundancy: `For` re-inserts every row on every change. A remote
 * host pays for redundancy on the wire, so it drops it here.
 *
 * Child order is kept exactly, as a linked list per parent: each node's
 * parent, its neighbours, and each parent's last child. An insert is
 * dropped only when the node already sits in that parent directly before
 * that anchor, which is the one case an `insertBefore` leaves unchanged.
 */
interface Shadow {
  readonly properties: Map<number, Map<string, PropertyValue>>;
  readonly text: Map<number, string>;
  readonly parent: Map<number, number>;
  readonly next: Map<number, number>;
  readonly previous: Map<number, number>;
  readonly last: Map<number, number>;
}

const makeShadow = (): Shadow => ({
  properties: new Map(),
  text: new Map(),
  parent: new Map(),
  next: new Map(),
  previous: new Map(),
  last: new Map(),
});

const clearShadow = (shadow: Shadow): void => {
  shadow.properties.clear();
  shadow.text.clear();
  shadow.parent.clear();
  shadow.next.clear();
  shadow.previous.clear();
  shadow.last.clear();
};

const lookup = <K, V>(map: ReadonlyMap<K, V>, key: K): Option.Option<V> =>
  Option.fromNullishOr(map.get(key));

/** Set or delete one link: absent means the list ends there. */
const link = <K>(map: Map<K, number>, key: K, value: Option.Option<number>): void =>
  Option.match(value, {
    onNone: () => void map.delete(key),
    onSome: (found) => void map.set(key, found),
  });

const unlink = (shadow: Shadow, node: number): void =>
  Option.match(lookup(shadow.parent, node), {
    onNone: () => {},
    onSome: (parent) => {
      const before = lookup(shadow.previous, node);
      const after = lookup(shadow.next, node);
      Option.map(before, (found) => link(shadow.next, found, after));
      Option.match(after, {
        onNone: () => link(shadow.last, parent, before),
        onSome: (found) => link(shadow.previous, found, before),
      });
      shadow.parent.delete(node);
      shadow.next.delete(node);
      shadow.previous.delete(node);
    },
  });

const place = (shadow: Shadow, parent: number, node: number, anchor: Option.Option<number>) => {
  const before = Option.match(anchor, {
    onNone: () => lookup(shadow.last, parent),
    onSome: (found) => lookup(shadow.previous, found),
  });
  shadow.parent.set(node, parent);
  link(shadow.previous, node, before);
  link(shadow.next, node, anchor);
  Option.map(before, (found) => shadow.next.set(found, node));
  Option.match(anchor, {
    onNone: () => void shadow.last.set(parent, node),
    onSome: (found) => void shadow.previous.set(found, node),
  });
};

/** Forget one node whose owner ended: its links, its properties, and its text. */
const forgetNode = (shadow: Shadow, node: number): void => {
  unlink(shadow, node);
  shadow.last.delete(node);
  shadow.properties.delete(node);
  shadow.text.delete(node);
};

/** The node already sits in `parent`, directly before `anchor` (or last). */
const inPlace = (
  shadow: Shadow,
  parent: number,
  node: number,
  anchor: Option.Option<number>,
): boolean => {
  const next = lookup(shadow.next, node);
  const sameNext = Option.match(anchor, {
    onNone: () => Option.isNone(next),
    onSome: (found) => Option.contains(next, found),
  });
  return sameNext && Option.contains(lookup(shadow.parent, node), parent);
};

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/** What a recorder holds right now. The server holds nothing else per client. */
export interface Retained {
  /** Operations recorded and not yet drained. */
  readonly ops: number;
  readonly listeners: number;
  /** Nodes the shadow knows, as a parent, a text, or a property holder. */
  readonly nodes: number;
}

export interface RecorderOptions {
  /**
   * The most operations the recorder holds undrained, counted from its first
   * drain: the first drawing is never sent. One more, and it drops them all,
   * stops recording, and completes `overflowed`: its client must resume from
   * a snapshot. None by default.
   */
  readonly limit?: number;
}

export interface Recorder {
  readonly host: Host<RemoteNode>;
  /**
   * Take every operation recorded since the last drain, with a `Forget` for
   * each node whose owner ended since, last. The listeners made so far are
   * now delivered, and `fire` reaches them.
   */
  readonly drain: () => ReadonlyArray<Op>;
  /** Completes once at least one operation is waiting to be drained, or on overflow. */
  readonly pending: Effect.Effect<void>;
  /** Completes once the undrained operations passed the limit. */
  readonly overflowed: Effect.Effect<void>;
  readonly isOverflowed: () => boolean;
  /**
   * Flush the reactive graph, and wait until no setup the runtime started
   * after the frame is still running: a list row's setup may draw nodes when
   * it ends. The drawing is then whole, so two recorders at one snapshot
   * drain the same operations.
   */
  readonly settled: Effect.Effect<void>;
  /**
   * Run the handler a client's event names. A listener that is unknown, was
   * removed, or was made after the last drain is ignored: a client can only
   * name a listener a drained operation gave it.
   */
  readonly fire: (event: RemoteEvent) => void;
  readonly retained: () => Retained;
  /** Forget everything: the operations, the handlers, and the shadow. */
  readonly release: () => void;
}

/**
 * A recording host. Ids count up from 1 in the order the runtime creates
 * nodes and listeners, so a client replaying the log in order always holds
 * the node an operation names, and two recorders that draw the same thing
 * give the same ids.
 */
export const recorder = (options: RecorderOptions = {}): Recorder => {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let nextId = 1;
  let delivered = 0;
  let limited = false;
  let ops: Array<Op> = [];
  let forgotten: Array<number> = [];
  let waiting = Deferred.makeUnsafe<void>();
  let wake = Deferred.makeUnsafe<void>();
  const overflow = Deferred.makeUnsafe<void>();
  let setups = 0;
  const handlers = new Map<number, EventHandler>();
  const shadow = makeShadow();

  const fresh = (): RemoteNode => {
    const node: RemoteNode = { id: nextId };
    nextId += 1;
    return node;
  };

  /** One more undrained entry: past the limit, drop them all and stop. */
  const grew = (): void => {
    if (limited && ops.length + forgotten.length > limit) {
      ops = [];
      forgotten = [];
      Deferred.doneUnsafe(overflow, Exit.void);
    }
    Deferred.doneUnsafe(waiting, Exit.void);
  };

  const record = (op: Op): void => {
    if (Deferred.isDoneUnsafe(overflow)) {
      return;
    }
    ops.push(op);
    grew();
  };

  const properties = (node: number): Map<string, PropertyValue> =>
    Option.getOrElse(lookup(shadow.properties, node), () => {
      const created = new Map<string, PropertyValue>();
      shadow.properties.set(node, created);
      return created;
    });

  const host: Host<RemoteNode> = {
    createElement: (tag: string, staticProps: StaticProps) => {
      const node = fresh();
      const props = Object.entries(staticProps);
      const held = properties(node.id);
      for (const [name, value] of props) {
        held.set(name, value);
      }
      record({ _tag: "CreateElement", node: node.id, tag, props });
      return node;
    },
    createText: (text: string) => {
      const node = fresh();
      shadow.text.set(node.id, text);
      record({ _tag: "CreateText", node: node.id, text });
      return node;
    },
    setProperty: (node, name, value) => {
      const held = properties(node.id);
      if (Option.contains(lookup(held, name), value)) {
        return;
      }
      held.set(name, value);
      record({ _tag: "SetProperty", node: node.id, name, value });
    },
    insert: (parent, node, anchor) => {
      const before = Option.map(anchor, (found) => found.id);
      if (inPlace(shadow, parent.id, node.id, before)) {
        return;
      }
      unlink(shadow, node.id);
      place(shadow, parent.id, node.id, before);
      record({ _tag: "Insert", parent: parent.id, node: node.id, anchor: before });
    },
    remove: (parent, node) => {
      // The DOM host removes only a child of `parent`; so does the shadow.
      if (!Option.contains(lookup(shadow.parent, node.id), parent.id)) {
        return;
      }
      unlink(shadow, node.id);
      record({ _tag: "Remove", parent: parent.id, node: node.id });
    },
    setText: (node, text) => {
      if (Option.contains(lookup(shadow.text, node.id), text)) {
        return;
      }
      shadow.text.set(node.id, text);
      record({ _tag: "SetText", node: node.id, text });
    },
    addEventListener: (node, name, handler): Cleanup => {
      const listener = fresh();
      handlers.set(listener.id, handler);
      record({ _tag: "AddListener", node: node.id, name, listener: listener.id });
      return () => {
        if (handlers.delete(listener.id)) {
          record({ _tag: "RemoveListener", listener: listener.id });
        }
      };
    },
    // A recorder has no live node, so a behaviour never runs here, as on the server host.
    attach: () => {},
    // The shadow keeps the node until the next drain, so a `Remove` the
    // runtime writes after the owner ends still finds it.
    forget: (node) => {
      if (Deferred.isDoneUnsafe(overflow)) {
        return;
      }
      forgotten.push(node.id);
      grew();
    },
    setupStarted: () => {
      setups += 1;
      let ended = false;
      return () => {
        if (!ended) {
          ended = true;
          setups -= 1;
          Deferred.doneUnsafe(wake, Exit.void);
        }
      };
    },
  };

  const settled: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      if (Deferred.isDoneUnsafe(wake)) {
        wake = Deferred.makeUnsafe<void>();
      }
      const signal = wake;
      yield* flush;
      if (setups === 0) {
        return;
      }
      yield* Deferred.await(signal);
    }
  });

  return {
    host,
    drain: () => {
      const taken: Array<Op> = ops;
      for (const node of forgotten) {
        forgetNode(shadow, node);
        taken.push({ _tag: "Forget", node });
      }
      ops = [];
      forgotten = [];
      delivered = nextId - 1;
      limited = true;
      if (Deferred.isDoneUnsafe(waiting) && !Deferred.isDoneUnsafe(overflow)) {
        waiting = Deferred.makeUnsafe<void>();
      }
      return taken;
    },
    pending: Effect.suspend(() => Deferred.await(waiting)),
    overflowed: Deferred.await(overflow),
    isOverflowed: () => Deferred.isDoneUnsafe(overflow),
    settled,
    fire: (event) =>
      Option.match(
        Option.filter(lookup(handlers, event.listener), () => event.listener <= delivered),
        {
          onNone: () => {},
          onSome: (handler) =>
            handler({ value: event.value, preventDefault: () => {}, form: Option.none() }),
        },
      ),
    retained: () => ({
      ops: ops.length,
      listeners: handlers.size,
      nodes: new Set([...shadow.properties.keys(), ...shadow.text.keys(), ...shadow.parent.keys()])
        .size,
    }),
    release: () => {
      ops = [];
      forgotten = [];
      handlers.clear();
      clearShadow(shadow);
    },
  };
};

// ---------------------------------------------------------------------------
// Drawing from a snapshot
// ---------------------------------------------------------------------------

/** The actor whose snapshot a server-driven view draws from. */
export interface Drive<C extends AnyContract> {
  readonly contract: C;
  readonly key: KeyOf<C>;
}

/** The wire address of a drive. */
export const addressOf = Effect.fn("Remote.addressOf")(function* <C extends AnyContract>(
  drive: Drive<C>,
) {
  const key = yield* Effect.orDie(Schema.encodeEffect(drive.contract.key)(drive.key));
  const address: Address = {
    contract: drive.contract.name,
    version: drive.contract.version,
    key,
  };
  return address;
});

export { sameAddress } from "../drive-transport.js";

/**
 * The transport a client draws with: the one held snapshot for the drive,
 * no change ever, so the drawing stands still, and nothing sent, because
 * every event goes to the server. It refuses every other read exactly as the
 * server's session does, from the same definition.
 */
const held = (address: Address, projection: Projection) =>
  driveOnly(
    address,
    { snapshot: Effect.succeed(projection), changes: () => Stream.never },
    sendsNothing,
  );

/**
 * The resume payload, in one JSON string: the session that will cut the
 * patches, the drive's committed revision and encoded snapshot (the shape
 * `resumeCodec` writes, read without the contract), and the digest of the
 * server's drawing at that snapshot.
 */
const ResumePayload = Schema.fromJsonString(
  Schema.Struct({
    session: Schema.String,
    revision: Schema.Int,
    state: Schema.Unknown,
    digest: Schema.String,
  }),
);
const SnapshotJson = Schema.fromJsonString(Schema.Unknown);

/** One node of a drawing, as its operations leave it. */
interface Drawing {
  readonly tag: string;
  readonly props: Map<string, PropertyValue>;
  text: string;
  readonly children: Array<number>;
  parent: Option.Option<number>;
}

const Canonical = Schema.fromJsonString(Schema.Unknown);

/**
 * A property value as the canonical form writes it: its type, then its
 * text, so `NaN`, the infinities, `-0`, and `0` are all distinct, and none
 * is taken for the string that spells it. JSON alone writes `NaN` and both
 * infinities as `null`, and `-0` as `0`.
 */
const canonicalValue = (value: PropertyValue): readonly [string, string] =>
  Match.value(value).pipe(
    Match.when(Match.string, (text): readonly [string, string] => ["s", text]),
    Match.when(Match.boolean, (flag): readonly [string, string] => ["b", String(flag)]),
    Match.orElse((number): readonly [string, string] => {
      if (Object.is(number, -0)) {
        return ["n", "-0"];
      }
      return ["n", String(number)];
    }),
  );

/**
 * The tree a list of operations leaves, in one canonical string: every node
 * by id, with its tag, its properties sorted by name, its text, and its
 * children in order, then every listener by id. Two drawings that end on the
 * same tree with the same ids give the same string, whatever order their
 * operations ran in: a row whose setup ends late is inserted after its list,
 * and the list may be inserted before or after that.
 */
const canonicalOf = (ops: ReadonlyArray<Op>): string => {
  const nodes = new Map<number, Drawing>([
    [root.id, { tag: "#root", props: new Map(), text: "", children: [], parent: Option.none() }],
  ]);
  const listeners = new Map<number, readonly [number, string]>();
  const each = (id: number, use: (node: Drawing) => void): void =>
    Option.match(lookup(nodes, id), { onNone: () => {}, onSome: use });
  const detach = (id: number): void =>
    each(id, (node) => {
      Option.map(node.parent, (parent) =>
        each(parent, (holder) => {
          holder.children.splice(holder.children.indexOf(id), 1);
        }),
      );
      node.parent = Option.none();
    });
  const apply = Match.type<Op>().pipe(
    Match.tagsExhaustive({
      CreateElement: (op) =>
        void nodes.set(op.node, {
          tag: op.tag,
          props: new Map(op.props),
          text: "",
          children: [],
          parent: Option.none(),
        }),
      CreateText: (op) =>
        void nodes.set(op.node, {
          tag: "#text",
          props: new Map(),
          text: op.text,
          children: [],
          parent: Option.none(),
        }),
      SetProperty: (op) => each(op.node, (node) => void node.props.set(op.name, op.value)),
      Insert: (op) => {
        detach(op.node);
        each(op.parent, (holder) => {
          const index = Option.match(op.anchor, {
            onNone: () => -1,
            onSome: (anchor) => holder.children.indexOf(anchor),
          });
          if (index >= 0) {
            holder.children.splice(index, 0, op.node);
          } else {
            holder.children.push(op.node);
          }
        });
        each(op.node, (node) => {
          node.parent = Option.some(op.parent);
        });
      },
      Remove: (op) =>
        each(op.node, (node) => {
          if (Option.contains(node.parent, op.parent)) {
            detach(op.node);
          }
        }),
      SetText: (op) =>
        each(op.node, (node) => {
          node.text = op.text;
        }),
      AddListener: (op) => void listeners.set(op.listener, [op.node, op.name]),
      RemoveListener: (op) => void listeners.delete(op.listener),
      Forget: (op) => {
        detach(op.node);
        nodes.delete(op.node);
      },
    }),
  );
  for (const op of ops) {
    apply(op);
  }
  const byId = <V>(map: ReadonlyMap<number, V>) => [...map.entries()].toSorted(([a], [b]) => a - b);
  return Schema.encodeSync(Canonical)({
    nodes: byId(nodes).map(([id, node]) => [
      id,
      node.tag,
      [...node.props.entries()]
        .toSorted(([a], [b]) => Order.String(a, b)) // by UTF-16 unit, the same on every locale
        .map(([name, value]) => [name, canonicalValue(value)]),
      node.text,
      node.children,
    ]),
    listeners: byId(listeners),
  });
};

/**
 * A digest of a drawing: the tree its operations leave, hashed. It is a
 * check that two drawings agree, not a secret: 32 bits, as fixed-width hex.
 */
export const digestOf = (ops: ReadonlyArray<Op>): string =>
  (Hash.string(canonicalOf(ops)) >>> 0).toString(16).padStart(8, "0");

/** The resume payload for one session, drawn from one committed projection. */
export const payloadOf = Effect.fn("Remote.payloadOf")(function* (
  session: string,
  projection: Projection,
  drawn: ReadonlyArray<Op>,
) {
  const state = yield* Schema.decodeEffect(SnapshotJson)(projection.snapshot);
  return yield* Schema.encodeEffect(ResumePayload)({
    session,
    revision: projection.revision,
    state,
    digest: digestOf(drawn),
  });
});

/** What a resume payload carries, with the projection as a transport hands it over. */
const readPayload = Effect.fn("Remote.readPayload")(function* (payload: string) {
  const resumed = yield* Schema.decodeEffect(ResumePayload)(payload);
  const snapshot = yield* Schema.encodeEffect(SnapshotJson)(resumed.state);
  const projection: Projection = { revision: resumed.revision, snapshot };
  return { session: resumed.session, digest: resumed.digest, projection };
});

const drawAt = Effect.fn("Remote.drawAt")(function* <Props, E, R, C extends AnyContract>(
  view: View<Props, E, R>,
  props: Props,
  drive: Drive<C>,
  projection: Projection,
) {
  const address = yield* addressOf(drive);
  const recording = recorder();
  const scope = yield* Scope.make();
  const ops = yield* Effect.gen(function* () {
    yield* mount(view, props, recording.host, root);
    yield* recording.settled;
    return recording.drain();
  }).pipe(
    Effect.provideService(ActorTransport, held(address, projection)),
    Scope.provide(scope),
    Effect.onExit((exit) => Scope.close(scope, exit)),
  );
  recording.release();
  return ops;
});

/**
 * Draw a view from a resume payload on a fresh recorder, and return the
 * operations. The drawing is the one a server's fresh recorder makes at the
 * same snapshot, id for id: this is how a client rebuilds its tree without
 * the first-mount op log crossing the wire.
 */
export const draw = Effect.fn("Remote.draw")(function* <Props, E, R, C extends AnyContract>(
  view: View<Props, E, R>,
  props: Props,
  drive: Drive<C>,
  payload: string,
) {
  const resumed = yield* readPayload(payload);
  return yield* drawAt(view, props, drive, resumed.projection);
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * What a drawing still needs from its caller: the view's own services. The
 * held transport and the drawing's scope are supplied inside.
 */
export type Drawn<R> = Exclude<Exclude<R, Scope.Scope>, ActorTransport>;

/** Where a client draws, and how its events reach the server. */
export interface Target<HostNode> {
  readonly host: Host<HostNode>;
  readonly root: HostNode;
  readonly send: (event: RemoteEvent) => void;
}

/** What a client holds right now. */
export interface ClientRetained {
  readonly nodes: number;
  readonly listeners: number;
}

export interface Client<E, R> {
  /**
   * Draw the view from a resume payload and hold position 0 of its session.
   * Whatever the client held before, at any age, is removed first. This is
   * the first mount and every reconnect: the payload is the drive's latest
   * snapshot. A drawing that is not the server's fails with `Diverged`, and
   * the client keeps what it held.
   */
  readonly resume: (payload: string) => Effect.Effect<void, E | Schema.SchemaError | Diverged, R>;
  /** Apply one patch, or refuse it whole and change nothing. */
  readonly apply: (patch: Patch) => Effect.Effect<void, ForeignSession | StaleClient | UnknownNode>;
  /** The position the client holds. */
  readonly position: Effect.Effect<number>;
  readonly retained: Effect.Effect<ClientRetained>;
  /**
   * Stop following: remove every listener and forget every id, and leave the
   * drawn nodes where they are. The next client over the same root adopts
   * them, as `Route.driven` does on a reconnect (#18). Every later patch is
   * refused with `ForeignSession`.
   */
  readonly detach: Effect.Effect<void>;
}

/**
 * What one operation asks of the ids the client holds: the nodes it names,
 * the listener it removes, and the node or listener it makes known.
 */
interface Needs {
  readonly nodes: ReadonlyArray<number>;
  readonly listener: Option.Option<number>;
  readonly makesNode: Option.Option<number>;
  readonly makesListener: Option.Option<number>;
  readonly forgetsNode: Option.Option<number>;
}

const nothing: Needs = {
  nodes: [],
  listener: Option.none(),
  makesNode: Option.none(),
  makesListener: Option.none(),
  forgetsNode: Option.none(),
};

const needsOf = Match.type<Op>().pipe(
  Match.tagsExhaustive({
    CreateElement: (op): Needs => ({ ...nothing, makesNode: Option.some(op.node) }),
    CreateText: (op): Needs => ({ ...nothing, makesNode: Option.some(op.node) }),
    SetProperty: (op): Needs => ({ ...nothing, nodes: [op.node] }),
    Insert: (op): Needs => ({
      ...nothing,
      nodes: [op.parent, op.node, ...Option.toArray(op.anchor)],
    }),
    Remove: (op): Needs => ({ ...nothing, nodes: [op.parent, op.node] }),
    SetText: (op): Needs => ({ ...nothing, nodes: [op.node] }),
    AddListener: (op): Needs => ({
      ...nothing,
      nodes: [op.node],
      makesListener: Option.some(op.listener),
    }),
    RemoveListener: (op): Needs => ({ ...nothing, listener: Option.some(op.listener) }),
    Forget: (op): Needs => ({ ...nothing, nodes: [op.node], forgetsNode: Option.some(op.node) }),
  }),
);

/**
 * The first id a list of operations names that would not be held when its
 * operation runs, given the nodes and listeners held before the first.
 */
const firstUnknown = (
  ops: ReadonlyArray<Op>,
  heldNodes: Iterable<number>,
  heldListeners: Iterable<number>,
): Option.Option<number> => {
  const known = new Set(heldNodes);
  const listening = new Set(heldListeners);
  for (const op of ops) {
    const needs = needsOf(op);
    const missing = Option.orElse(
      Option.fromNullishOr(needs.nodes.find((id) => !known.has(id))),
      () => Option.filter(needs.listener, (id) => !listening.has(id)),
    );
    if (Option.isSome(missing)) {
      return missing;
    }
    Option.map(needs.makesNode, (id) => known.add(id));
    Option.map(needs.makesListener, (id) => listening.add(id));
    Option.map(needs.forgetsNode, (id) => known.delete(id));
  }
  return Option.none();
};

/**
 * A client of one server-driven view. It replays operations against any
 * host, so the DOM and a reference host are driven the same way.
 */
export const client = <Props, E, R, C extends AnyContract, HostNode>(
  view: View<Props, E, R>,
  props: Props,
  drive: Drive<C>,
  target: Target<HostNode>,
): Client<E, Drawn<R>> => {
  let nodes = new Map<number, HostNode>([[root.id, target.root]]);
  let cleanups = new Map<number, Cleanup>();
  let position = 0;
  let session = Option.none<string>();

  const node = (id: number): HostNode => Option.getOrThrow(lookup(nodes, id));

  const run = Match.type<Op>().pipe(
    Match.tagsExhaustive({
      CreateElement: (op) =>
        void nodes.set(op.node, target.host.createElement(op.tag, Object.fromEntries(op.props))),
      CreateText: (op) => void nodes.set(op.node, target.host.createText(op.text)),
      SetProperty: (op) => target.host.setProperty(node(op.node), op.name, op.value),
      Insert: (op) =>
        target.host.insert(node(op.parent), node(op.node), Option.map(op.anchor, node)),
      Remove: (op) => target.host.remove(node(op.parent), node(op.node)),
      SetText: (op) => target.host.setText(node(op.node), op.text),
      AddListener: (op) =>
        void cleanups.set(
          op.listener,
          target.host.addEventListener(node(op.node), op.name, (event) =>
            target.send({ listener: op.listener, value: event.value }),
          ),
        ),
      RemoveListener: (op) => {
        Option.map(lookup(cleanups, op.listener), (cleanup) => cleanup());
        cleanups.delete(op.listener);
      },
      Forget: (op) => void nodes.delete(op.node),
    }),
  );

  /** Remove what the client drew: the root's children, and every listener. */
  const clear = (): void => {
    for (const cleanup of cleanups.values()) {
      cleanup();
    }
    for (const id of nodes.keys()) {
      if (id !== root.id) {
        target.host.remove(target.root, node(id));
      }
    }
    nodes = new Map<number, HostNode>([[root.id, target.root]]);
    cleanups = new Map<number, Cleanup>();
  };

  const self: Client<E, Drawn<R>> = {
    resume: (payload) =>
      Effect.gen(function* () {
        const resumed = yield* readPayload(payload);
        const ops = yield* drawAt(view, props, drive, resumed.projection);
        const drawn = digestOf(ops);
        if (drawn !== resumed.digest) {
          return yield* Diverged.make({ expected: resumed.digest, drawn });
        }
        clear();
        for (const op of ops) {
          run(op);
        }
        position = 0;
        session = Option.some(resumed.session);
      }),
    apply: (patch) =>
      Effect.suspend((): Effect.Effect<void, ForeignSession | StaleClient | UnknownNode> => {
        if (!Option.contains(session, patch.session)) {
          return Effect.fail(ForeignSession.make({ held: session, sent: patch.session }));
        }
        if (patch.from !== position) {
          return Effect.fail(StaleClient.make({ held: position, wanted: patch.from }));
        }
        const missing = firstUnknown(patch.ops, nodes.keys(), cleanups.keys());
        if (Option.isSome(missing)) {
          return Effect.fail(UnknownNode.make({ node: missing.value }));
        }
        for (const op of patch.ops) {
          run(op);
        }
        position = patch.to;
        return Effect.void;
      }),
    position: Effect.sync(() => position),
    retained: Effect.sync(() => ({ nodes: nodes.size - 1, listeners: cleanups.size })),
    detach: Effect.sync(() => {
      for (const cleanup of cleanups.values()) {
        cleanup();
      }
      nodes = new Map<number, HostNode>([[root.id, target.root]]);
      cleanups = new Map<number, Cleanup>();
      session = Option.none();
    }),
  };
  return self;
};
