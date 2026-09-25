import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorHost,
  ActorTransport,
  Behavior,
  CommandId,
  Policies,
  Policy,
  implementTransparent,
  QueryCache,
} from "effect-frame/actor";
import { contract, ref, resumeCodec } from "effect-frame/actor/client";
import type { Applied, SnapshotOf } from "effect-frame/actor/client";
import { Location, Route, mount as mountRouter } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import { Dom, Html, View } from "effect-frame/view";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, Match, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  eventually,
  eventuallyEffect,
  frame,
  hydrateWith,
  install,
  makeControl,
  release,
  sideOf,
  stateOf,
  textOf,
} from "../view/streaming-fixture.js";
import {
  NotFound,
  blogLabels,
  blogRoutes,
  buildInto,
  generationOf,
  origin,
  readText,
  tempDirectory,
} from "./prerender-fixture.js";

/**
 * A loaded prerendered page (#23 §3, #86): its baked query values paint at
 * once, marked stale, and revalidate once; its actor island resumes from the
 * revision the build baked and catches up over `changes`. See
 * `docs/design/prerender.md`.
 */

/** Every proof here builds real files first. */
const platform = it.scopedLive.layer(BunServices.layer);

/** A Location that stays where it is put, and moves when the router moves it. */
const locationAt = (href: string): Effect.Effect<LocationService> =>
  Effect.map(Ref.make(new URL(href)), (current) => ({
    current: Ref.get(current),
    push: (url) => Ref.set(current, url),
    replace: (url) => Ref.set(current, url),
    pops: Stream.never,
  }));

describe("a prerendered page's baked queries (#23 §3.2)", () => {
  platform(
    "a baked query value paints at once, marked stale, and revalidates once to Ready{stale:false}",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl(blogLabels));
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        yield* buildInto(server, blogRoutes, out);
        const html = yield* readText(`${yield* generationOf(out)}/blog/first/index.html`);

        // The client's read of the key is held, so the stale paint is observable.
        const clientControl = makeControl({ "post-first": "fresh body" }, ["post-first"]);
        const client = yield* sideOf(clientControl);
        const location = yield* locationAt(`${origin}/blog/first`);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, root) =>
          mountRouter({ routes: blogRoutes, notFound: NotFound, host, root }).pipe(
            Effect.provideService(Location, location),
          ),
        );
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        // No readiness state is drawn: the baked value is on screen, and stale.
        expect(textOf("#body")).toBe("body of first");
        expect(yield* stateOf(client, "post-first")).toEqual({
          _tag: "Ready",
          value: { label: "body of first" },
          stale: true,
        });

        // One read per baked key confirms it.
        yield* eventually("the revalidation started", () => clientControl.calls.length > 0);
        yield* release(clientControl, "post-first");
        yield* eventuallyEffect(
          "the confirmed value",
          Effect.map(
            stateOf(client, "post-first"),
            (state) => state._tag === "Ready" && !state.stale,
          ),
        );
        expect(yield* stateOf(client, "post-first")).toEqual({
          _tag: "Ready",
          value: { label: "fresh body" },
          stale: false,
        });
        yield* eventually("the fresh body", () => textOf("#body") === "fresh body");
        expect(clientControl.calls).toEqual(["post-first"]);
      }),
    10_000,
  );
});

// ---------------------------------------------------------------------------
// One actor island (#23 §3.1)
// ---------------------------------------------------------------------------

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
const NoteSnapshot = Schema.Struct({ count: Schema.Finite });
type NoteSnapshot = Schema.Schema.Type<typeof NoteSnapshot>;
type NoteMessage = Schema.Schema.Type<typeof Add>;

const Note = contract("PrerenderNote", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: NoteSnapshot,
  message: Add,
});

const NoteLive = implementTransparent(Note, {
  behavior: Behavior.reducer<NoteSnapshot, NoteMessage>({
    initial: { count: 0 },
    reduce: (state, message) =>
      Match.type<NoteMessage>().pipe(
        Match.tagsExhaustive({ Add: (add) => ({ count: state.count + add.amount }) }),
      )(message),
  }),
});

const Resume = resumeCodec(Note);
const bakedId = "baked-note";

/** The snapshot the page baked, when this is the client. The build has none. */
const Baked = Context.Reference<Option.Option<Applied<SnapshotOf<typeof Note>>>>(
  "tests/router/prerender-resume/Baked",
  { defaultValue: () => Option.none() },
);

const noteSegment = Route.segment("note", {
  path: "/notes/:key",
  params: Schema.Struct({ key: Schema.String }),
});

const noteRoute = Route.prerender(
  "notes",
  Route.leaf(noteSegment, () =>
    Effect.gen(function* () {
      const note = yield* Effect.orDie(ref(Note, "n1", { resume: yield* Baked }));
      return (
        <article id="note">
          <p id="count">{View.bind(note.state, (state) => state.count)}</p>
        </article>
      );
    }),
  ),
  { inputs: [Route.inputs(noteSegment, Effect.succeed([{ key: "n1" }]))] },
);

/** The page's document writes the resume script for its island, as SSR does. */
const noteDocument = (_page: Prerender.Page) =>
  Effect.gen(function* () {
    const note = yield* Effect.orDie(ref(Note, "n1"));
    const snapshot = yield* note.applied.get;
    const payload = yield* Effect.orDie(Schema.encodeEffect(Resume)(snapshot));
    return {
      head: frame.head,
      tail: `${frame.tail}${Html.jsonScript(bakedId, payload)}`,
      end: frame.end,
    };
  });

const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

/** A fresh actor store: a new host with nothing committed. */
const freshStore = Layer.build(
  ActorHost.layer({ implementations: [NoteLive], store: ActorHost.memoryStore }).pipe(
    Layer.provide(policies),
    Layer.orDie,
  ),
);

const commandId = Schema.decodeSync(CommandId);

const add = (store: Context.Context<ActorTransport>, id: string) =>
  Effect.gen(function* () {
    const note = yield* ref(Note, "n1");
    return yield* note.call(
      { _tag: "Add", amount: 1 },
      { commandId: commandId(id), timeout: "1 second" },
    );
  }).pipe(Effect.orDie, Effect.scoped, Effect.provideContext(store));

/**
 * A document that commits to the note after it read the snapshot, and
 * before the view renders: the store moves on between the two reads.
 */
const racingDocument = (store: Context.Context<ActorTransport>) => (page: Prerender.Page) =>
  Effect.gen(function* () {
    const document = yield* noteDocument(page);
    yield* add(store, "between-document-and-view");
    return document;
  });

/** Build the note page over `store`, and return its document. */
const buildNote = (
  store: Context.Context<ActorTransport>,
  document: (page: Prerender.Page) => ReturnType<typeof noteDocument> = noteDocument,
) =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory;
    const out = `${directory}/out`;
    yield* Prerender.build({
      routes: [noteRoute],
      notFound: NotFound,
      document,
      client: Effect.succeed("export {};"),
      out,
      timeLimit: "5 seconds",
    }).pipe(Effect.provideContext(store));
    return yield* readText(`${yield* generationOf(out)}/notes/n1/index.html`);
  });

/** The client: a cache, and a transport that records every `changes` cursor. */
const spyClient = (store: Context.Context<ActorTransport>, afters: Array<number>) =>
  Effect.gen(function* () {
    const transport = Context.get(store, ActorTransport);
    const cache = yield* Layer.build(QueryCache.layer);
    const spy: ActorTransport["Service"] = {
      ...transport,
      changes: (address, after) => {
        afters.push(after);
        return transport.changes(address, after);
      },
    };
    return Context.add(cache, ActorTransport, spy);
  });

/** Install the page, read its baked snapshot, and hydrate the router over `client`. */
const mountNote = (html: string, client: Context.Context<QueryCache | ActorTransport>) =>
  Effect.gen(function* () {
    yield* install(html);
    const baked = yield* Option.match(Dom.readJsonScript(bakedId), {
      onNone: () => Effect.die("the page baked no snapshot"),
      onSome: (json) => Effect.orDie(Schema.decodeEffect(Resume)(json)),
    });
    const location = yield* locationAt(`${origin}/notes/n1`);
    const { report } = yield* hydrateWith(client, (host, root) =>
      mountRouter({ routes: [noteRoute], notFound: NotFound, host, root }).pipe(
        Effect.provideService(Location, location),
        Effect.provideService(Baked, Option.some(baked)),
      ),
    );
    return { baked, report };
  });

describe("a prerendered page's actor island (#23 §3.1)", () => {
  platform(
    "a prerendered page's actor resumes from the baked revision R, calls changes after R, and shows the later state",
    () =>
      Effect.gen(function* () {
        const store = yield* freshStore;
        yield* add(store, "before-build");
        const html = yield* buildNote(store);
        // A commit after the build and before the mount.
        yield* add(store, "after-build");

        // A page with a client island loads the one bundle.
        expect(html).toContain(Prerender.clientScript);
        const afters: Array<number> = [];
        const client = yield* spyClient(store, afters);
        const { baked, report } = yield* mountNote(html, client);
        expect(baked.revision.value).toBe(1);
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        yield* eventually("the later count", () => textOf("#count") === "2");
        expect(afters).toEqual([1]);
      }),
    10_000,
  );

  platform(
    "the page's HTML and its resume script show one revision, although the store moved between them",
    () =>
      Effect.gen(function* () {
        const store = yield* freshStore;
        yield* add(store, "before-build");
        const html = yield* buildNote(store, racingDocument(store));
        yield* install(html);
        const baked = yield* Option.match(Dom.readJsonScript(bakedId), {
          onNone: () => Effect.die("the page baked no snapshot"),
          onSome: (json) => Effect.orDie(Schema.decodeEffect(Resume)(json)),
        });
        // The store holds two commits; the page shows the one instant it baked.
        expect(baked.revision.value).toBe(1);
        expect(baked.state).toEqual({ count: 1 });
        expect(textOf("#count")).toBe("1");
      }),
    10_000,
  );

  platform(
    "an actor does not move while the build reads it: the build's change stream is empty",
    () =>
      Effect.gen(function* () {
        const store = yield* freshStore;
        const address = { contract: Note.name, version: Note.version, key: "n1" };
        const transport = Context.get(store, ActorTransport);
        // A store whose actor always has a newer revision to deliver.
        const moving: ActorTransport["Service"] = {
          ...transport,
          changes: (at) => Stream.fromEffect(transport.snapshot(at)),
        };
        const delivers = (changes: ReturnType<typeof transport.changes>) =>
          Stream.runHead(changes).pipe(
            Effect.timeoutOption("200 millis"),
            Effect.map((head) => Option.isSome(Option.flatten(head))),
            Effect.orDie,
          );
        expect(yield* delivers(moving.changes(address, 0))).toBe(true);
        expect(yield* delivers(Prerender.oneInstant(moving).changes(address, 0))).toBe(false);
      }),
  );

  platform(
    "a client whose baked revision the store no longer holds takes the newest, and no scope hangs",
    () =>
      Effect.gen(function* () {
        const built = yield* freshStore;
        yield* add(built, "one");
        const html = yield* buildNote(built);

        // The store is replaced: a new instance, whose history is not the one baked.
        const replaced = yield* freshStore;
        yield* add(replaced, "a");
        yield* add(replaced, "b");
        yield* add(replaced, "c");

        const afters: Array<number> = [];
        const closed = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* spyClient(replaced, afters);
            const { report } = yield* mountNote(html, client);
            expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
            yield* eventually("the store's latest count", () => textOf("#count") === "3");
          }),
        ).pipe(Effect.timeoutOption("3 seconds"));
        expect(Option.isSome(closed)).toBe(true);
        expect(afters).toEqual([1]);
      }),
    10_000,
  );
});
