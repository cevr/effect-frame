import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Actor,
  ActorHost,
  Behavior,
  CommandId,
  implementTransparent,
  Policies,
  Policy,
} from "effect-frame/actor";
import type { KeyOf, TransportService } from "effect-frame/actor/client";
import { ActorTransport, contract, Source } from "effect-frame/actor/client";
import type { Host } from "effect-frame/view";
import { Dom, For, Html, Remote, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import * as Driven from "effect-frame/view/driven";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * The streamed host-operation wire (#15) and reconnect over it (#27), over a
 * view shaped like the Notes page: a keyed list with a bound checkbox and
 * text per row, a count, and a button whose handler runs on the server.
 */

const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const Note = Schema.Struct({ id: Schema.String, text: Schema.String, done: Schema.Boolean });
type Note = Schema.Schema.Type<typeof Note>;

const NotesSnapshot = Schema.Struct({ notes: Schema.Array(Note) });
type NotesSnapshot = Schema.Schema.Type<typeof NotesSnapshot>;

const Add = Schema.TaggedStruct("Add", { id: Schema.String, text: Schema.String });
const Toggle = Schema.TaggedStruct("Toggle", { id: Schema.String });
const Drop = Schema.TaggedStruct("Drop", { id: Schema.String });
const Promote = Schema.TaggedStruct("Promote", { id: Schema.String });
const NotesMessage = Schema.Union([Add, Toggle, Drop, Promote]);
type NotesMessage = Schema.Schema.Type<typeof NotesMessage>;

const Notes = contract("Notes", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: NotesSnapshot,
  message: NotesMessage,
});

const reduce = (state: NotesSnapshot, message: NotesMessage): NotesSnapshot =>
  Match.type<NotesMessage>().pipe(
    Match.tagsExhaustive({
      Add: (add) => ({ notes: [...state.notes, { id: add.id, text: add.text, done: false }] }),
      Toggle: (toggle) => ({
        notes: state.notes.map((note) => {
          if (note.id === toggle.id) {
            return { ...note, done: !note.done };
          }
          return note;
        }),
      }),
      Drop: (drop) => ({ notes: state.notes.filter((note) => note.id !== drop.id) }),
      Promote: (promote) => ({
        notes: [
          ...state.notes.filter((note) => note.id === promote.id),
          ...state.notes.filter((note) => note.id !== promote.id),
        ],
      }),
    }),
  )(message);

const NotesLive = implementTransparent(Notes, {
  behavior: Behavior.reducer<NotesSnapshot, NotesMessage>({ initial: { notes: [] }, reduce }),
});

const id = Schema.decodeSync(CommandId);

interface PageProps {
  readonly key: KeyOf<typeof Notes>;
}

/** One view for every host: the recorder, the HTML host, and the DOM. */
const NotesPage = (props: PageProps) =>
  Effect.gen(function* () {
    const notes = yield* Actor.remote(Notes, props.key);
    return (
      <section id="notes-page">
        <button
          id="add"
          type="button"
          onClick={View.event(() =>
            notes.send({ _tag: "Add", id: "clicked", text: "added by a click" }),
          )}
        >
          add
        </button>
        <ul id="list">
          <For
            each={Source.select(notes.state, (snapshot) => snapshot.notes)}
            keyBy={(note) => note.id}
          >
            {(note) => (
              <li>
                <input type="checkbox" checked={View.bind(note, (value) => value.done)} />
                <span>{View.bind(note, (value) => value.text)}</span>
              </li>
            )}
          </For>
        </ul>
        <p id="count">{View.bind(notes.state, (snapshot) => snapshot.notes.length)}</p>
      </section>
    );
  });

/** The same list, with each row drawn only after its setup yields: a late setup. */
const LateRows = (props: PageProps) =>
  Effect.gen(function* () {
    const notes = yield* Actor.remote(Notes, props.key);
    const rows = yield* View.list({
      each: Source.select(notes.state, (snapshot) => snapshot.notes),
      keyBy: (note: Note) => note.id,
      row: (note) =>
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          return <li>{View.bind(note, (value) => value.text)}</li>;
        }),
    });
    return <ul id="late">{rows}</ul>;
  });

interface GatedProps extends PageProps {
  readonly gate: Deferred.Deferred<void>;
}

/** Each row draws only once the test opens the gate: a late setup the test holds. */
const GatedRows = (props: GatedProps) =>
  Effect.gen(function* () {
    const notes = yield* Actor.remote(Notes, props.key);
    const rows = yield* View.list({
      each: Source.select(notes.state, (snapshot) => snapshot.notes),
      keyBy: (note: Note) => note.id,
      row: (note) =>
        Effect.gen(function* () {
          yield* Deferred.await(props.gate);
          return (
            <li>
              <input type="checkbox" checked={View.bind(note, (value) => value.done)} />
              {View.bind(note, (value) => value.text)}
            </li>
          );
        }),
    });
    return <ul id="gated">{rows}</ul>;
  });

/** A view that reads a second actor besides its drive. */
const TwoActors = (props: PageProps) =>
  Effect.gen(function* () {
    yield* Actor.remote(Notes, props.key);
    const other = yield* Actor.remote(Notes, `${props.key}-other`);
    return <p>{View.bind(other.state, (snapshot) => snapshot.notes.length)}</p>;
  });

/** One button per note, whose handler runs on the server. */
const RowButtons = (props: PageProps) =>
  Effect.gen(function* () {
    const notes = yield* Actor.remote(Notes, props.key);
    return (
      <ul id="buttons">
        <For
          each={Source.select(notes.state, (snapshot) => snapshot.notes)}
          keyBy={(note) => note.id}
        >
          {(note) => (
            <li>
              <button
                type="button"
                onClick={View.event(() =>
                  Effect.flatMap(note.get, (value) => notes.send({ _tag: "Toggle", id: value.id })),
                )}
              >
                {View.bind(note, (value) => value.text)}
              </button>
            </li>
          )}
        </For>
      </ul>
    );
  });

/** A view that breaks the precondition: each drawing reads a counter. */
let drawings = 0;
const Counted = (props: PageProps) =>
  Effect.gen(function* () {
    yield* Actor.remote(Notes, props.key);
    drawings += 1;
    return <p id="counted">{`drawing ${String(drawings)}`}</p>;
  });

/** Each drawing's title is the next number JSON cannot write. */
let titled = 0;
const TitledByNumber = (props: PageProps) =>
  Effect.gen(function* () {
    yield* Actor.remote(Notes, props.key);
    const title = [Number.NaN, Number.POSITIVE_INFINITY][titled % 2] ?? 0;
    titled += 1;
    return <div id="titled" title={title} />;
  });

const withHost = it.scoped.layer(
  ActorHost.layer({ implementations: [NotesLive], store: ActorHost.memoryStore }).pipe(
    Layer.provide(policies),
  ),
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const call = (key: string, message: NotesMessage, commandId: string) =>
  Effect.gen(function* () {
    const notes = yield* Actor.remote(Notes, key);
    yield* notes.call(message, { commandId: id(commandId), timeout: "1 second" });
  });

const seed = (key: string, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) =>
      call(
        key,
        { _tag: "Add", id: `n${String(index)}`, text: `note number ${String(index)}` },
        `seed-${key}-${String(index)}`,
      ),
  );

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** An op log as the wire carries it, so two logs compare byte for byte. */
const encoded = (ops: ReadonlyArray<Remote.Op>) =>
  Schema.encodeEffect(Remote.PatchJson)({ session: "s", from: 0, to: 1, ops });

/**
 * Compare trees, not strings. `value` and `checked` are properties the DOM
 * does not keep in step with their attributes: the HTML host writes an
 * attribute, the DOM host a property. The comparison reads the live property.
 */
const LIVE = new Set(["value", "checked"]);

const treeOf = (node: Node): string => {
  if (node.nodeType === 3) {
    return `#${String(node.textContent)}`;
  }
  if (!(node instanceof Element)) {
    return "";
  }
  const attributes = Array.from(node.attributes)
    .filter((attribute) => !LIVE.has(attribute.name))
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .toSorted();
  const live = [...LIVE]
    .filter((name) => name in node)
    .map((name) => `@${name}=${String(Reflect.get(node, name))}`);
  const children = Array.from(node.childNodes).map(treeOf).join(",");
  return `${node.tagName.toLowerCase()}[${[...attributes, ...live].join(" ")}](${children})`;
};

const treeOfChildren = (root: Element): string => Array.from(root.childNodes).map(treeOf).join(",");

const treeOfMarkup = (markup: string): string => {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  return treeOfChildren(holder);
};

/** The tree `Html.renderToString` draws at the actor's latest revision. */
const latest = (key: string) => Effect.map(Html.renderToString(NotesPage, { key }), treeOfMarkup);

/** The latest tree, once a handler's command on the server has committed. */
const latestWith = (key: string, text: string) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    return yield* latest(key);
  }).pipe(
    Effect.repeat({ until: (tree) => tree.includes(text) }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(2),
      orElse: () => Effect.die(`the tree never showed ${text}`),
    }),
  );

const makeRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const main = document.createElement("main");
    document.body.appendChild(main);
    return main;
  }),
  (main) => Effect.sync(() => main.remove()),
);

/** A client on the DOM that keeps the events it sends, for the test to deliver. */
const domClient = (key: string) =>
  Effect.gen(function* () {
    const root = yield* makeRoot;
    const sent: Array<Remote.RemoteEvent> = [];
    const client = Remote.client(
      NotesPage,
      { key },
      { contract: Notes, key },
      { host: Dom.host, root, send: (event) => void sent.push(event) },
    );
    return { root, sent, client };
  });

/** One connection: a session in a scope of its own, and a pull on its patches. */
const connect = (key: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const session = yield* Scope.provide(
      Driven.session(NotesPage, { key }, { contract: Notes, key }),
      scope,
    );
    const pull = yield* Scope.provide(Stream.toPull(session.patches), scope);
    const next = pull.pipe(
      Effect.map((patches) => patches[0]),
      Effect.timeoutOrElse({
        duration: Duration.seconds(2),
        orElse: () => Effect.die("no patch arrived"),
      }),
      Effect.orDie,
    );
    return { session, next, drop: Scope.close(scope, Exit.void) };
  });

/** Let every fiber that is ready run, under the test clock. */
const settle = Effect.gen(function* () {
  for (let step = 0; step < 200; step += 1) {
    yield* Effect.yieldNow;
  }
});

/** Settle until a condition holds, or fail the test. */
const until = <E, R>(label: string, check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 50; round += 1) {
      if (yield* check) {
        return;
      }
      yield* settle;
    }
    return yield* Effect.die(`never: ${label}`);
  });

/** The next patch, or none once the session has gone quiet. */
const nextOrNone = (pull: Effect.Effect<Remote.Patch>) =>
  Effect.raceFirst(Effect.map(pull, Option.some), Effect.as(settle, Option.none<Remote.Patch>()));

/** The session id a resume payload names. */
const sessionOf = (payload: string) =>
  Effect.map(
    Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ session: Schema.String })))(payload),
    (resumed) => resumed.session,
  );

/** One note as the actor holds it now. */
const noteOf = (key: string, noteId: string) =>
  Effect.gen(function* () {
    const notes = yield* Actor.remote(Notes, key);
    const snapshot = yield* notes.state.get;
    return Option.fromNullishOr(snapshot.notes.find((note) => note.id === noteId));
  });

/** Apply patches as they come until the client's tree is the expected one. */
const follow = (
  next: Effect.Effect<Remote.Patch>,
  client: Remote.Client<unknown, unknown>,
  root: Element,
  expected: string,
) =>
  Effect.gen(function* () {
    while (treeOfChildren(root) !== expected) {
      yield* client.apply(yield* next);
    }
  });

// ---------------------------------------------------------------------------
// The wire (#15)
// ---------------------------------------------------------------------------

describe("the streamed host-operation wire (#15)", () => {
  withHost("a resumed client follows the server's patches to the tree the HTML host draws", () =>
    Effect.gen(function* () {
      yield* seed("w1", 3);
      const { root, client } = yield* domClient("w1");
      const { session, next } = yield* connect("w1");
      yield* client.resume(session.resume);
      expect(treeOfChildren(root)).toBe(yield* latest("w1"));

      yield* call("w1", { _tag: "Toggle", id: "n1" }, "w1-toggle");
      yield* follow(next, client, root, yield* latest("w1"));
      yield* call("w1", { _tag: "Drop", id: "n0" }, "w1-drop");
      yield* follow(next, client, root, yield* latest("w1"));
      yield* call("w1", { _tag: "Add", id: "n9", text: "late" }, "w1-add");
      yield* follow(next, client, root, yield* latest("w1"));
      expect(root.querySelectorAll("li").length).toBe(3);
    }),
  );

  withHost("toggling one note in twenty sends only the operation that changed", () =>
    Effect.gen(function* () {
      yield* seed("w2", 20);
      const { root, client } = yield* domClient("w2");
      const { session, next } = yield* connect("w2");
      yield* client.resume(session.resume);

      yield* call("w2", { _tag: "Toggle", id: "n7" }, "w2-toggle");
      const expected = yield* latest("w2");
      const ops: Array<Remote.Op> = [];
      while (treeOfChildren(root) !== expected) {
        const patch = yield* next;
        ops.push(...patch.ops);
        yield* client.apply(patch);
      }
      // The runtime re-inserts all twenty rows and re-runs every binding; the
      // shadow drops each write that would not change the client's tree.
      expect(ops).toEqual([
        { _tag: "SetProperty", node: expect.any(Number), name: "checked", value: true },
      ]);
    }),
  );

  withHost("an event crosses back to the handler on the server, and its change comes back", () =>
    Effect.gen(function* () {
      yield* seed("w3", 1);
      const { root, sent, client } = yield* domClient("w3");
      const { session, next } = yield* connect("w3");
      yield* client.resume(session.resume);

      const button = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#add")));
      button.dispatchEvent(new Event("click"));
      expect(sent.length).toBe(1);
      yield* Effect.forEach(sent, session.fire);
      yield* follow(next, client, root, yield* latestWith("w3", "added by a click"));
      expect(root.textContent).toContain("added by a click");
    }),
  );

  it.effect(
    "the recorder's shadow keeps child order exactly, and drops only what changes nothing",
    () =>
      Effect.sync(() => {
        const recording = Remote.recorder();
        const host = recording.host;
        const list = host.createElement("ul", {});
        const na = host.createText("a");
        const nb = host.createText("b");
        const nc = host.createText("c");
        const nd = host.createText("d");
        host.insert(Remote.root, list, Option.none());
        for (const node of [na, nb, nc]) {
          host.insert(list, node, Option.none());
        }
        recording.drain();

        // Every row re-inserted where it already is: nothing crosses.
        host.insert(list, na, Option.some(nb));
        host.insert(list, nb, Option.some(nc));
        host.insert(list, nc, Option.none());
        expect(recording.drain()).toEqual([]);

        // c moves to the front: c, a, b. Then c, a and b are in place.
        host.insert(list, nc, Option.some(na));
        host.insert(list, nc, Option.some(na));
        host.insert(list, na, Option.some(nb));
        host.insert(list, nb, Option.none());
        expect(recording.drain()).toEqual([
          { _tag: "Insert", parent: list.id, node: nc.id, anchor: Option.some(na.id) },
        ]);

        // A remove names its parent; a node elsewhere is not touched.
        host.remove(Remote.root, na);
        expect(recording.drain()).toEqual([]);
        host.remove(list, na);
        host.remove(list, na);
        expect(recording.drain()).toEqual([{ _tag: "Remove", parent: list.id, node: na.id }]);

        // c, b. A new node before b sits after c, so c before it is in place.
        host.insert(list, nd, Option.some(nb));
        host.insert(list, nc, Option.some(nd));
        host.insert(list, nb, Option.none());
        expect(recording.drain()).toEqual([
          { _tag: "Insert", parent: list.id, node: nd.id, anchor: Option.some(nb.id) },
        ]);
      }),
  );

  withHost("the shadow never drifts from the client over a long run of changes", () =>
    Effect.gen(function* () {
      yield* seed("w4", 6);
      const { root, client } = yield* domClient("w4");
      const { session, next } = yield* connect("w4");
      yield* client.resume(session.resume);
      // A fixed pseudo-random run (Park and Miller), so a failure replays exactly.
      let state = 7;
      const random = (bound: number): number => {
        state = (state * 16807) % 2147483647;
        return Math.floor((state / 2147483647) * bound);
      };
      let added = 6;
      for (let step = 0; step < 60; step += 1) {
        const ids = Array.from({ length: added }, (_, index) => `n${String(index)}`);
        const target = ids[random(ids.length)] ?? "n0";
        const kinds: ReadonlyArray<NotesMessage> = [
          { _tag: "Toggle", id: target },
          { _tag: "Promote", id: target },
          { _tag: "Drop", id: target },
          { _tag: "Add", id: `n${String(added)}`, text: `note number ${String(added)}` },
        ];
        const message = Option.getOrThrow(Option.fromNullishOr(kinds[random(kinds.length)]));
        if (message._tag === "Add") {
          added += 1;
        }
        yield* call("w4", message, `w4-${String(step)}`);
        yield* follow(next, client, root, yield* latest("w4"));
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Reconnect (#27)
// ---------------------------------------------------------------------------

describe("reconnect over the op wire (#27)", () => {
  withHost("a reconnecting client resumes from the actor's snapshot", () =>
    Effect.gen(function* () {
      yield* seed("r1", 5);
      const { root, client } = yield* domClient("r1");
      const first = yield* connect("r1");
      yield* client.resume(first.session.resume);
      yield* call("r1", { _tag: "Toggle", id: "n0" }, "r1-a");
      yield* follow(first.next, client, root, yield* latest("r1"));

      // The socket drops. Revisions pass that this client never sees.
      yield* first.drop;
      yield* call("r1", { _tag: "Drop", id: "n2" }, "r1-b");
      yield* call("r1", { _tag: "Toggle", id: "n4" }, "r1-c");
      yield* call("r1", { _tag: "Add", id: "n5", text: "while away" }, "r1-d");

      const second = yield* connect("r1");
      yield* client.resume(second.session.resume);
      expect(treeOfChildren(root)).toBe(yield* latest("r1"));
      expect(yield* client.position).toBe(0);
    }),
  );

  withHost("a reconnect costs the snapshot, not the first-mount op log", () =>
    Effect.gen(function* () {
      yield* seed("r2", 20);
      const { session } = yield* connect("r2");
      const rebuild = yield* Remote.draw(
        NotesPage,
        { key: "r2" },
        { contract: Notes, key: "r2" },
        session.resume,
      );
      const patch = yield* encoded(rebuild);
      yield* Effect.logInfo(
        `reconnect at 20 notes: resume ${String(bytes(session.resume))} B, rebuild patch ${String(bytes(patch))} B (${String(rebuild.length)} ops)`,
      );
      // The resume carries a session id and a digest besides the snapshot.
      expect(bytes(session.resume) * 5).toBeLessThan(bytes(patch));
    }),
  );

  withHost("a client of any age reconnects at constant cost", () =>
    Effect.gen(function* () {
      const costs: Array<number> = [];
      for (const missed of [2, 10, 40]) {
        const key = `r3-${String(missed)}`;
        yield* seed(key, 10);
        const { root, client } = yield* domClient(key);
        const first = yield* connect(key);
        yield* client.resume(first.session.resume);
        yield* first.drop;
        // An even number of toggles leaves the state as it was; only the
        // revision moves, and it stays two digits wide.
        for (let index = 0; index < missed; index += 1) {
          yield* call(key, { _tag: "Toggle", id: "n3" }, `${key}-${String(index)}`);
        }
        const second = yield* connect(key);
        yield* client.resume(second.session.resume);
        expect(treeOfChildren(root)).toBe(yield* latest(key));
        costs.push(bytes(second.session.resume));
      }
      expect(new Set(costs).size).toBe(1);
    }),
  );

  withHost("a stale patch is refused and never silently applied", () =>
    Effect.gen(function* () {
      yield* seed("r4", 3);
      const { root, client } = yield* domClient("r4");
      const { session, next } = yield* connect("r4");
      yield* client.resume(session.resume);
      const before = treeOfChildren(root);

      yield* call("r4", { _tag: "Toggle", id: "n0" }, "r4-a");
      const missed = yield* next;
      yield* call("r4", { _tag: "Drop", id: "n1" }, "r4-b");
      const later = yield* next;

      const stale = yield* Effect.flip(client.apply(later));
      expect(stale).toEqual(Remote.StaleClient.make({ held: 0, wanted: missed.to }));
      expect(treeOfChildren(root)).toBe(before);

      // A patch at the right position that names a node the client never
      // drew is refused whole, too.
      const drifted: Remote.Patch = {
        session: missed.session,
        from: 0,
        to: 1,
        ops: [
          { _tag: "SetText", node: 1, text: "changed" },
          { _tag: "SetText", node: 9999, text: "nowhere" },
        ],
      };
      const unknown = yield* Effect.flip(client.apply(drifted));
      expect(unknown).toEqual(Remote.UnknownNode.make({ node: 9999 }));
      expect(treeOfChildren(root)).toBe(before);
      expect(yield* client.position).toBe(0);

      // In order, both apply; applying the same patch twice is refused.
      yield* client.apply(missed);
      yield* client.apply(later);
      const repeated = yield* Effect.flip(client.apply(later));
      expect(repeated._tag).toBe("StaleClient");
    }),
  );

  withHost("the server holds no history for each client", () =>
    Effect.gen(function* () {
      yield* seed("r5", 5);
      const { root, client } = yield* domClient("r5");
      const { session, next, drop } = yield* connect("r5");
      yield* client.resume(session.resume);

      // Mounted: no operation kept, and the snapshot it mounted from is gone.
      const mounted = yield* session.retained;
      expect(mounted.ops).toBe(0);
      expect(mounted.snapshot).toBe(false);
      expect(mounted.listeners).toBe(1);
      expect(mounted.nodes).toBeGreaterThan(0);

      yield* call("r5", { _tag: "Toggle", id: "n1" }, "r5-a");
      yield* call("r5", { _tag: "Add", id: "n6", text: "more" }, "r5-b");
      yield* follow(next, client, root, yield* latest("r5"));
      expect((yield* session.retained).ops).toBe(0);

      yield* drop;
      expect(yield* session.retained).toEqual({ ops: 0, listeners: 0, nodes: 0, snapshot: false });
    }),
  );

  withHost("a rebuilt server-side mount reproduces the client tree exactly", () =>
    Effect.gen(function* () {
      yield* seed("r6", 4);
      const { root, sent, client } = yield* domClient("r6");
      const first = yield* connect("r6");
      yield* client.resume(first.session.resume);
      yield* call("r6", { _tag: "Toggle", id: "n2" }, "r6-a");
      yield* follow(first.next, client, root, yield* latest("r6"));
      yield* first.drop;
      yield* call("r6", { _tag: "Drop", id: "n1" }, "r6-b");

      // Re-mount on a fresh recorder. Its patches address the ids the client
      // drew from the snapshot, so every later change lands where it should.
      const second = yield* connect("r6");
      yield* client.resume(second.session.resume);
      yield* call("r6", { _tag: "Drop", id: "n0" }, "r6-c");
      yield* call("r6", { _tag: "Toggle", id: "n3" }, "r6-d");
      yield* call("r6", { _tag: "Add", id: "n7", text: "after the rebuild" }, "r6-e");
      yield* follow(second.next, client, root, yield* latest("r6"));

      // A listener id from the rebuilt mount reaches the rebuilt handler.
      const button = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#add")));
      button.dispatchEvent(new Event("click"));
      yield* Effect.forEach(sent, second.session.fire);
      const expected = yield* latestWith("r6", "added by a click");
      yield* follow(second.next, client, root, expected);

      // The same view mounted straight on the DOM host lands on the same tree.
      const reference = yield* makeRoot;
      const page = yield* ViewTest.make({
        host: Dom.host,
        root: reference,
        setup: (host, node) => View.mount(NotesPage, { key: "r6" }, host, node),
      });
      yield* page.waitFor({
        label: "the reference host shows the latest revision",
        until: (node) => node instanceof Element && treeOfChildren(node) === expected,
      });
      expect(treeOfChildren(root)).toBe(treeOfChildren(reference));
      expect(treeOfChildren(root)).toBe(expected);
    }),
  );

  withHost("rendering is deterministic from a snapshot", () =>
    Effect.gen(function* () {
      yield* seed("r7", 5);
      yield* call("r7", { _tag: "Toggle", id: "n2" }, "r7-a");
      const { session } = yield* connect("r7");
      const drive = { contract: Notes, key: "r7" };
      const once = yield* Remote.draw(NotesPage, { key: "r7" }, drive, session.resume);
      const twice = yield* Remote.draw(NotesPage, { key: "r7" }, drive, session.resume);
      expect(once.length).toBeGreaterThan(40);
      expect(yield* encoded(twice)).toBe(yield* encoded(once));

      // A recorder mounted against the live actor at the same revision draws
      // the same operations: the drawing the session drops is the client's.
      const live = Remote.recorder();
      yield* View.mount(NotesPage, { key: "r7" }, live.host, Remote.root);
      yield* live.settled;
      expect(yield* encoded(live.drain())).toBe(yield* encoded(once));
    }),
  );
  withHost("a drawing from a snapshot waits for the rows whose setup ends late", () =>
    Effect.gen(function* () {
      yield* seed("r8", 4);
      const session = yield* Driven.session(
        LateRows,
        { key: "r8" },
        { contract: Notes, key: "r8" },
      );
      const drawn = yield* Remote.draw(
        LateRows,
        { key: "r8" },
        { contract: Notes, key: "r8" },
        session.resume,
      );
      const rows = drawn.filter((op) => op._tag === "CreateElement" && op.tag === "li");
      expect(rows.length).toBe(4);
    }),
  );

  withHost("a resume releases every listener the client held before", () =>
    Effect.gen(function* () {
      yield* seed("r9", 2);
      let listening = 0;
      const counting: Host<Node> = {
        ...Dom.host,
        addEventListener: (node, name, handler) => {
          listening += 1;
          const cleanup = Dom.host.addEventListener(node, name, handler);
          return () => {
            listening -= 1;
            cleanup();
          };
        },
      };
      const root = yield* makeRoot;
      const client = Remote.client(
        NotesPage,
        { key: "r9" },
        { contract: Notes, key: "r9" },
        { host: counting, root, send: () => {} },
      );
      for (const attempt of [1, 2, 3]) {
        const { session, drop } = yield* connect("r9");
        yield* client.resume(session.resume);
        yield* drop;
        expect([attempt, listening]).toEqual([attempt, 1]);
      }
    }),
  );

  withHost("a revision that lands while the session mounts is drawn on both sides", () =>
    Effect.gen(function* () {
      yield* seed("r10", 3);
      const real = yield* ActorTransport;
      // Every read after the first commits a change first: the worst moment
      // for a revision to land is between the session's read and the mount's.
      let reads = 0;
      const racing: TransportService = {
        ...real,
        snapshot: (address) =>
          Effect.gen(function* () {
            reads += 1;
            if (reads > 1) {
              yield* call("r10", { _tag: "Toggle", id: "n1" }, `r10-${String(reads)}`).pipe(
                Effect.provideService(ActorTransport, real),
                Effect.scoped,
                Effect.orDie,
              );
            }
            return yield* real.snapshot(address);
          }),
      };
      const { root, client } = yield* domClient("r10");
      const { session, next } = yield* connect("r10").pipe(
        Effect.provideService(ActorTransport, racing),
      );
      yield* client.resume(session.resume);
      yield* call("r10", { _tag: "Add", id: "n3", text: "after the mount" }, "r10-add");
      yield* follow(next, client, root, yield* latest("r10"));
    }),
  );
});

// ---------------------------------------------------------------------------
// What a session and a client guarantee each other (#87)
// ---------------------------------------------------------------------------

describe("what a session and a client guarantee each other (#87)", () => {
  withHost("a patch from another session is refused, even at the held position", () =>
    Effect.gen(function* () {
      yield* seed("g1", 3);
      const { root, client } = yield* domClient("g1");
      const old = yield* connect("g1");
      yield* client.resume(old.session.resume);
      // The client reconnects while the old session still runs. Both count
      // from 0, so only the session id tells their patches apart.
      const fresh = yield* connect("g1");
      yield* client.resume(fresh.session.resume);
      const before = treeOfChildren(root);

      yield* call("g1", { _tag: "Toggle", id: "n1" }, "g1-a");
      const stray = yield* old.next;
      expect(stray.from).toBe(0);
      const foreign = yield* Effect.flip(client.apply(stray));
      expect(foreign._tag).toBe("ForeignSession");
      expect(treeOfChildren(root)).toBe(before);

      yield* follow(fresh.next, client, root, yield* latest("g1"));
      expect(yield* client.position).toBe(1);
    }),
  );

  withHost("a change that lands while a late row is still drawing reaches the client", () =>
    Effect.gen(function* () {
      yield* seed("g2", 3);
      const gate = yield* Deferred.make<void>();
      const props = { key: "g2", gate };
      const drive = { contract: Notes, key: "g2" };
      const scope = yield* Scope.make();
      const opening = yield* Effect.forkChild(
        Scope.provide(Driven.session(GatedRows, props, drive), scope),
      );
      // The session is mounted and waits on the rows. A change commits now.
      yield* settle;
      yield* call("g2", { _tag: "Toggle", id: "n1" }, "g2-a");
      yield* settle;
      yield* Deferred.done(gate, Exit.void);
      const session = yield* Fiber.join(opening);

      const root = yield* makeRoot;
      const client = Remote.client(GatedRows, props, drive, {
        host: Dom.host,
        root,
        send: () => {},
      });
      yield* client.resume(session.resume);
      const pull = yield* Scope.provide(Stream.toPull(session.patches), scope);
      const checked = () => Array.from(root.querySelectorAll("input")).map((box) => box.checked);
      while (checked().join(",") !== "false,true,false") {
        const patch = yield* nextOrNone(Effect.map(Effect.orDie(pull), (patches) => patches[0]));
        if (Option.isNone(patch)) {
          return yield* Effect.die(`the change never arrived: ${checked().join(",")}`);
        }
        yield* client.apply(patch.value);
      }
    }),
  );

  withHost("a view that reads a second actor fails on the server as it fails on the client", () =>
    Effect.gen(function* () {
      yield* seed("g3", 1);
      const drive = { contract: Notes, key: "g3" };
      const onServer = yield* Effect.flip(Driven.session(TwoActors, { key: "g3" }, drive));
      const { session } = yield* connect("g3");
      const onClient = yield* Effect.flip(
        Remote.draw(TwoActors, { key: "g3" }, drive, session.resume),
      );
      expect(onServer._tag).toBe("Unreachable");
      expect(onClient._tag).toBe("Unreachable");
      expect(Reflect.get(onClient, "reason")).toBe(Reflect.get(onServer, "reason"));
    }),
  );

  withHost("a client that stops taking patches costs the limit, not the backlog", () =>
    Effect.gen(function* () {
      yield* seed("g4", 2);
      const drive = { contract: Notes, key: "g4" };
      const session = yield* Driven.session(NotesPage, { key: "g4" }, drive, { limit: 4 });
      // Nothing pulls the patches. Each toggle records one operation.
      for (let index = 0; index < 10; index += 1) {
        yield* call("g4", { _tag: "Toggle", id: "n0" }, `g4-${String(index)}`);
        yield* settle;
        expect((yield* session.retained).ops).toBeLessThanOrEqual(4);
      }
      yield* until(
        "the session closed its mount",
        Effect.map(session.retained, (held) => held.listeners === 0),
      );
      expect(yield* session.retained).toEqual({ ops: 0, listeners: 0, nodes: 0, snapshot: false });
      const failure = yield* Effect.flip(Stream.runHead(session.patches));
      expect(failure).toEqual(Driven.Backlogged.make({ limit: 4 }));
    }),
  );

  withHost("adding and dropping rows for a long time holds a fixed number of nodes", () =>
    Effect.gen(function* () {
      yield* seed("g5", 3);
      const { root, client } = yield* domClient("g5");
      const { session, next } = yield* connect("g5");
      yield* client.resume(session.resume);
      const notes = yield* Actor.remote(Notes, "g5");
      const send = (message: NotesMessage, commandId: string) =>
        notes.call(message, { commandId: id(commandId), timeout: "1 second" });
      const first = () =>
        Option.getOrThrow(Option.fromNullishOr(root.querySelector("input"))).checked;
      // Each cycle adds a row, drops it, and toggles the first note, so the
      // client knows the cycle's patches have all arrived once it shows the toggle.
      const cycle = (index: number) =>
        Effect.gen(function* () {
          const row = `c${String(index)}`;
          yield* send({ _tag: "Add", id: row, text: `cycle ${String(index)}` }, `g5-add-${row}`);
          yield* send({ _tag: "Drop", id: row }, `g5-drop-${row}`);
          yield* send({ _tag: "Toggle", id: "n0" }, `g5-mark-${row}`);
          const toggled = index % 2 === 0;
          while (first() !== toggled) {
            yield* client.apply(yield* next);
          }
        });
      yield* cycle(0);
      const server = (yield* session.retained).nodes;
      const held = (yield* client.retained).nodes;
      for (let index = 1; index < 200; index += 1) {
        yield* cycle(index);
      }
      expect((yield* session.retained).nodes).toBe(server);
      expect((yield* client.retained).nodes).toBe(held);
    }),
  );

  withHost("a view that draws differently from the same snapshot fails the resume", () =>
    Effect.gen(function* () {
      yield* seed("g6", 1);
      const drive = { contract: Notes, key: "g6" };
      const session = yield* Driven.session(Counted, { key: "g6" }, drive);
      const root = yield* makeRoot;
      const client = Remote.client(Counted, { key: "g6" }, drive, {
        host: Dom.host,
        root,
        send: () => {},
      });
      const diverged = yield* Effect.flip(client.resume(session.resume));
      expect(diverged._tag).toBe("Diverged");
      expect(treeOfChildren(root)).toBe("");
    }),
  );

  withHost("an event may name only a listener a patch has delivered", () =>
    Effect.gen(function* () {
      const drive = { contract: Notes, key: "g7" };
      const scope = yield* Scope.make();
      const session = yield* Scope.provide(Driven.session(RowButtons, { key: "g7" }, drive), scope);
      const pull = yield* Scope.provide(Stream.toPull(session.patches), scope);
      yield* call("g7", { _tag: "Add", id: "n0", text: "first" }, "g7-a");
      yield* until(
        "the server drew the new row's button",
        Effect.map(session.retained, (held) => held.listeners === 1),
      );

      // A client guessing ids reaches no handler the wire has not given it.
      for (let listener = 1; listener <= 100; listener += 1) {
        yield* session.fire({ listener, value: "" });
      }
      yield* settle;
      expect(Option.map(yield* noteOf("g7", "n0"), (note) => note.done)).toEqual(
        Option.some(false),
      );

      const patch = yield* Effect.map(Effect.orDie(pull), (patches) => patches[0]);
      const given = Option.fromNullishOr(
        patch?.ops.find((op): op is typeof Remote.AddListener.Type => op._tag === "AddListener"),
      );
      const listener = Option.getOrThrow(Option.map(given, (op) => op.listener));
      yield* session.fire({ listener, value: "" });
      yield* until(
        "the delivered listener reached its handler",
        Effect.map(noteOf("g7", "n0"), (note) => Option.exists(note, (found) => found.done)),
      );
    }),
  );

  withHost("a drawing with NaN where the server drew Infinity fails the resume", () =>
    Effect.gen(function* () {
      yield* seed("g8", 1);
      const drive = { contract: Notes, key: "g8" };
      const session = yield* Driven.session(TitledByNumber, { key: "g8" }, drive);
      const root = yield* makeRoot;
      const client = Remote.client(TitledByNumber, { key: "g8" }, drive, {
        host: Dom.host,
        root,
        send: () => {},
      });
      const diverged = yield* Effect.flip(client.resume(session.resume));
      expect(diverged._tag).toBe("Diverged");
    }),
  );

  withHost("every number a view can bind crosses the wire as it is", () =>
    Effect.gen(function* () {
      yield* seed("g9", 1);
      const { session } = yield* connect("g9");
      const seen: Array<unknown> = [];
      const root = yield* makeRoot;
      const client = Remote.client(
        NotesPage,
        { key: "g9" },
        { contract: Notes, key: "g9" },
        {
          host: {
            ...Dom.host,
            setProperty: (node, name, value) => {
              if (name === "data-number") {
                seen.push(value);
              }
              Dom.host.setProperty(node, name, value);
            },
          },
          root,
          send: () => {},
        },
      );
      yield* client.resume(session.resume);
      const numbers = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, 1.5];
      const sent: Remote.Patch = {
        session: yield* sessionOf(session.resume),
        from: 0,
        to: 1,
        ops: numbers.map((value): Remote.Op => ({
          _tag: "SetProperty",
          node: 1,
          name: "data-number",
          value,
        })),
      };
      const text = yield* Schema.encodeEffect(Remote.PatchJson)(sent);
      expect(text).not.toContain("null");
      yield* client.apply(yield* Schema.decodeEffect(Remote.PatchJson)(text));
      expect(seen.length).toBe(numbers.length);
      seen.forEach((value, index) => expect(Object.is(value, numbers[index])).toBe(true));
    }),
  );

  it.effect("a digest tells every property value apart", () =>
    Effect.sync(() => {
      const values: ReadonlyArray<string | number | boolean> = [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -0,
        0,
        "NaN",
        "Infinity",
        "0",
        true,
        "true",
      ];
      const digests = values.map((value) =>
        Remote.digestOf([
          { _tag: "CreateElement", node: 1, tag: "div", props: [["title", value]] },
        ]),
      );
      expect(new Set(digests).size).toBe(values.length);
    }),
  );
});
