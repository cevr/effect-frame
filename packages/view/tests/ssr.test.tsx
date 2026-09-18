import { registerDom } from "./dom-setup.js";

registerDom();

import { ActorHost, Behavior, CommandId, implementTransparent } from "@effect-frame/actor";
import { contract, ref, resumeCodec } from "@effect-frame/actor/client";
import type { Applied, KeyOf, SnapshotOf } from "@effect-frame/actor/client";
import { Dom, Html, View, mount, render } from "@effect-frame/view";
import { Deferred, Effect, Exit, Match, Option, Schema, Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * Server render, snapshot transfer, hydration, and live updates over one
 * contract. The transport is in process; the wire is the same one the HTTP
 * transport carries, and `tests/http.test.ts` in the actor package proves
 * reconnect over a real socket.
 */

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
const Rename = Schema.TaggedStruct("Rename", { title: Schema.String });
const NoteMessage = Schema.Union([Add, Rename]);
type NoteMessage = Schema.Schema.Type<typeof NoteMessage>;

const NoteSnapshot = Schema.Struct({ count: Schema.Finite, title: Schema.String });
type NoteSnapshot = Schema.Schema.Type<typeof NoteSnapshot>;

const Note = contract("Note", {
  version: 1,
  key: Schema.String,
  snapshot: NoteSnapshot,
  message: NoteMessage,
});

const NoteLive = implementTransparent(
  Note,
  Behavior.reducer<NoteSnapshot, NoteMessage>({
    initial: { count: 0, title: "untitled" },
    reduce: (state, message) =>
      Match.type<NoteMessage>().pipe(
        Match.tagsExhaustive({
          Add: (add) => ({ ...state, count: state.count + add.amount }),
          Rename: (rename) => ({ ...state, title: rename.title }),
        }),
      )(message),
  }),
);

const id = Schema.decodeSync(CommandId);
const Resume = resumeCodec(Note);

interface PageProps {
  readonly key: KeyOf<typeof Note>;
  /** The snapshot the server embedded, when this is the client. */
  readonly resume: Option.Option<Applied<SnapshotOf<typeof Note>>>;
  /** Runs when the view's scope closes, so a test can see the cleanup. */
  readonly onClose: Effect.Effect<void>;
}

const NotePage = View.make((props: PageProps) =>
  Effect.gen(function* () {
    const view = yield* View.Context;
    const note = yield* ref(Note, props.key, { resume: props.resume });
    yield* Effect.addFinalizer(() => props.onClose);
    return (
      <article>
        <h1>{view.bind(note.state, (state) => state.title)}</h1>
        <p id="count">{view.bind(note.state, (state) => state.count)}</p>
      </article>
    );
  }),
);

const server = (key: string) =>
  Effect.gen(function* () {
    const note = yield* ref(Note, key);
    return { note, key };
  });

/** What the server sends: the rendered view and the snapshot it rendered from. */
const renderPage = (key: string) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<boolean>();
    const html = yield* Html.renderToString(NotePage, {
      key,
      resume: Option.none(),
      onClose: Deferred.succeed(closed, true).pipe(Effect.asVoid),
    });
    const note = yield* ref(Note, key);
    const snapshot = yield* note.applied.get;
    const payload = yield* Effect.orDie(Schema.encodeEffect(Resume)(snapshot));
    const script = Html.jsonScript("note", payload);
    return { html, snapshot, script, page: `${html}${script}`, closed };
  });

/**
 * Put a server page into the document the way a browser would: the view's
 * markup inside its mount root, the snapshot script beside it in the body.
 */
const install = (html: string, script: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const main = document.createElement("main");
      main.innerHTML = html;
      document.body.appendChild(main);
      document.body.insertAdjacentHTML("beforeend", script);
      return main;
    }),
    (main) =>
      Effect.sync(() => {
        main.remove();
        Option.map(Option.fromNullishOr(document.getElementById("note")), (node) => node.remove());
      }),
  );

const hydrate = (main: HTMLElement, key: string, onClose: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const embedded = Dom.readJsonScript("note");
    const resume = yield* Option.match(embedded, {
      onNone: () => Effect.succeed(Option.none<Applied<NoteSnapshot>>()),
      onSome: (json) => Effect.map(Effect.orDie(Schema.decodeEffect(Resume)(json)), Option.some),
    });
    const hydration = Dom.hydrate(main);
    yield* mount(NotePage, { key, resume, onClose }, hydration.host, main);
    yield* render;
    return yield* hydration.finish;
  });

const withHost = it.scoped.layer(ActorHost.layerMemory([NoteLive]));

describe("server render and hydration", () => {
  withHost("the server renders the snapshot and escapes everything it writes", () =>
    Effect.gen(function* () {
      const { note } = yield* server("n1");
      yield* note.call(
        { _tag: "Rename", title: '<script>alert("x")</script> & co' },
        {
          commandId: id("r1"),
          timeout: "1 second",
        },
      );
      const { html, page, snapshot } = yield* renderPage("n1");
      expect(html).toBe(
        '<article><h1>&lt;script&gt;alert("x")&lt;/script&gt; &amp; co</h1><p id="count">0</p></article>',
      );
      expect(snapshot.revision).toBe(1);
      expect(page).not.toContain("</script></script>");
      expect(page).toContain("\\u003c/script\\u003e");
    }),
  );

  withHost("a render releases its own resources before the string returns", () =>
    Effect.gen(function* () {
      const { closed } = yield* renderPage("n2");
      expect(yield* Deferred.isDone(closed)).toBe(true);
    }),
  );

  withHost("concurrent renders never share state", () =>
    Effect.gen(function* () {
      const a = yield* server("a");
      const b = yield* server("b");
      yield* a.note.call(
        { _tag: "Rename", title: "Alpha" },
        { commandId: id("a1"), timeout: "1 second" },
      );
      yield* b.note.call(
        { _tag: "Rename", title: "Beta" },
        { commandId: id("b1"), timeout: "1 second" },
      );
      const [first, second] = yield* Effect.all([renderPage("a"), renderPage("b")], {
        concurrency: "unbounded",
      });
      expect(first.html).toContain("<h1>Alpha</h1>");
      expect(second.html).toContain("<h1>Beta</h1>");
      expect(first.html).not.toContain("Beta");
    }),
  );

  withHost("the client adopts the server nodes, agrees with them, and then follows changes", () =>
    Effect.gen(function* () {
      const { html, script } = yield* renderPage("n3");
      const main = yield* install(html, script);
      const heading = Option.fromNullishOr(main.querySelector("h1"));

      const report = yield* hydrate(main, "n3");
      expect(report).toEqual({ mismatches: [], unclaimed: 0 });
      expect(Option.fromNullishOr(main.querySelector("h1"))).toEqual(heading);

      const { note } = yield* server("n3");
      yield* note.call({ _tag: "Add", amount: 5 }, { commandId: id("c1"), timeout: "1 second" });
      yield* render;
      expect(main.querySelector("#count")?.textContent).toBe("5");
    }),
  );

  withHost("a revision committed between render and hydrate is applied, not lost", () =>
    Effect.gen(function* () {
      const { html, script, snapshot } = yield* renderPage("n4");
      const { note } = yield* server("n4");
      yield* note.call({ _tag: "Add", amount: 2 }, { commandId: id("c1"), timeout: "1 second" });

      const main = yield* install(html, script);
      const report = yield* hydrate(main, "n4");
      expect(report.mismatches).toEqual([]);
      expect(snapshot.revision).toBe(0);
      expect(main.querySelector("#count")?.textContent).toBe("2");
    }),
  );

  withHost("a disagreeing server tree is reported and the client wins", () =>
    Effect.gen(function* () {
      const { html, script } = yield* renderPage("n5");
      const main = yield* install(html.replace("<h1>", "<h2>").replace("</h1>", "</h2>"), script);
      const report = yield* hydrate(main, "n5");
      expect(report.mismatches.length).toBeGreaterThan(0);
      expect(main.querySelector("h1")?.textContent).toBe("untitled");
      expect(main.querySelector("h2")).toBeNull();
    }),
  );

  withHost("closing the client scope stops following the actor", () =>
    Effect.gen(function* () {
      const { html, script } = yield* renderPage("n6");
      const main = yield* install(html, script);
      const closed = yield* Deferred.make<boolean>();
      const life = yield* Scope.make();
      yield* hydrate(main, "n6", Deferred.succeed(closed, true).pipe(Effect.asVoid)).pipe(
        Scope.provide(life),
      );
      yield* Scope.close(life, Exit.void);
      expect(yield* Deferred.isDone(closed)).toBe(true);
      expect(main.childNodes.length).toBe(0);
    }),
  );
});
