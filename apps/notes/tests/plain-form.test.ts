import { platformFetch } from "./dom-setup.js";

import type { ActorTransport } from "effect-frame/actor/client";
import { Form, HttpTransport, ref } from "effect-frame/actor/client";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Notes, demoKey } from "../src/contract.js";
import { inProcess } from "../src/notes.server.js";
import type { NotesRuntime } from "../src/server.js";
import { makeRuntime, makeServer } from "../src/server.js";

/**
 * The notes page with no script (#21). A real server on a free port; the
 * browser is `fetch` with redirects left unfollowed. It reads the page,
 * fills the compose form, and posts it as a browser would.
 */

const realFetch: HttpTransport.FetchLike = (input, init) => platformFetch(input, init);

const asClientOf =
  (url: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, ActorTransport>> =>
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(
      effect,
      HttpTransport.layer({
        baseUrl: `${url}/actors`,
        reconnect: HttpTransport.defaultReconnect,
      }).pipe(Layer.provide(Layer.succeed(HttpTransport.Fetch, realFetch))),
    );

const serve = Effect.gen(function* () {
  const runtime = yield* Effect.acquireRelease(
    Effect.sync((): NotesRuntime => makeRuntime(inProcess)),
    (built) => Effect.promise(() => built.dispose()),
  );
  return yield* Effect.acquireRelease(
    Effect.promise(() => makeServer({ port: 0, runtime })),
    (server) => Effect.promise(() => server.stop()),
  );
});

const pageOf = (url: string) =>
  Effect.flatMap(
    Effect.promise(() => platformFetch(url)),
    (response) => Effect.promise(() => response.text()),
  );

/** The compose form's hidden inputs, in document order. */
const hiddenOf = (html: string): ReadonlyArray<[string, string]> => {
  const start = html.indexOf('<form id="compose"');
  const form = html.slice(start, html.indexOf("</form>", start));
  return Array.from(
    form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g),
    (match): [string, string] => [String(match[1]), String(match[2]).replaceAll("&amp;", "&")],
  );
};

const post = (url: string, body: string) =>
  Effect.map(
    Effect.promise(() =>
      platformFetch(`${url}/actors/form`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
      }),
    ),
    (response) => ({
      status: response.status,
      location: Option.getOrElse(Option.fromNullishOr(response.headers.get("location")), () => ""),
    }),
  );

/** The committed notes once the actor reaches `revision`. */
const notesAt = (url: string, revision: number) =>
  asClientOf(url)(
    Effect.scoped(
      Effect.flatMap(ref(Notes, demoKey), (notes) =>
        Stream.runHead(
          Stream.filter(notes.applied.changes, (applied) => applied.revision.value >= revision),
        ),
      ),
    ),
  ).pipe(Effect.flatMap(Effect.fromOption), Effect.timeout("2 seconds"), Effect.orDie);

describe("notes with no script", () => {
  it.scopedLive("the compose form posts, adds the note, and returns to the page", () =>
    Effect.gen(function* () {
      const server = yield* serve;
      const page = yield* pageOf(server.url);
      expect(page).toContain('<form id="compose" method="post" action="/actors/form">');
      const hidden = hiddenOf(page);
      const commandId = Option.getOrElse(
        Option.map(
          Option.fromNullishOr(hidden.find(([name]) => name === "$command")),
          ([, value]) => value,
        ),
        () => "",
      );

      const reply = yield* post(
        server.url,
        Form.toBody(Form.fromEntries([...hidden, ["text", "buy milk"]])),
      );

      expect(reply).toEqual({ status: 303, location: "/" });
      const applied = yield* notesAt(server.url, 1);
      expect(applied.state.notes).toEqual([{ id: commandId, text: "buy milk", done: false }]);
    }),
  );

  it.scopedLive("the same form posted twice adds one note", () =>
    Effect.gen(function* () {
      const server = yield* serve;
      const page = yield* pageOf(server.url);
      const body = Form.toBody(Form.fromEntries([...hiddenOf(page), ["text", "walk dog"]]));

      const first = yield* post(server.url, body);
      const second = yield* post(server.url, body);

      expect([first.status, second.status]).toEqual([303, 303]);
      const applied = yield* notesAt(server.url, 1);
      expect(applied.revision.value).toBe(1);
      expect(applied.state.notes.map((note) => note.text)).toEqual(["walk dog"]);
      // The page after the redirect shows the note.
      const after = yield* pageOf(server.url);
      expect(after).toContain("<span>walk dog</span>");
    }),
  );
});
