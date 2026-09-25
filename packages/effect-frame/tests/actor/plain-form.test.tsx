/* oxlint-disable effect/noGlobals -- Bun.serve and fetch are this test's platform boundary: a real socket and a browser with no script. */
import { Actor, HttpServer } from "effect-frame/actor";
import { ActorTransport, Form, contract } from "effect-frame/actor/client";
import type { AnyContract } from "effect-frame/actor/client";
import { Context, Effect, Hash, Layer, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { Wire } from "../plain-form-fixture.js";
import {
  Tasks,
  TasksDocument,
  Vault,
  VaultDocument,
  board,
  vault as vaultKey,
  hiddenOf,
  hiddenValue,
  formPosts,
  makeWire,
  recordedTransport,
  refusedTitle,
} from "../plain-form-fixture.js";

/**
 * Plain-form posts over a real socket (#21, #32). The browser is `fetch`
 * with redirects left unfollowed, so each test reads the 303 itself. The
 * page, the form route, and the JSON route share one in-process host.
 */

const actorPrefix = "/actors";

interface Served {
  readonly url: string;
  readonly wire: Wire;
  readonly context: Context.Context<ActorTransport>;
}

const page = TasksDocument;

/** A server for `contracts`, whose form route and page draw `document`. */
const serveWith = <E,>(
  contracts: ReadonlyArray<AnyContract>,
  document: Effect.Effect<string, E, ActorTransport>,
) =>
  Effect.gen(function* () {
    const wire = yield* makeWire;
    const context = yield* Layer.build(recordedTransport(wire));
    const actors = yield* Effect.provideContext(
      HttpServer.make({ principal: HttpServer.anonymous }),
      context,
    );
    const forms = yield* Effect.provideContext(
      HttpServer.form({
        contracts,
        principal: HttpServer.anonymous,
        login: Option.none(),
        render: () => document,
      }),
      Context.add(context, ActorTransport, formPosts(Context.get(context, ActorTransport))),
    );
    const run = Effect.runPromiseWith(context);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url);
            if (url.pathname === `${actorPrefix}/form`) {
              return run(forms(request));
            }
            if (url.pathname.startsWith(actorPrefix)) {
              const stripped = new URL(request.url);
              stripped.pathname = url.pathname.slice(actorPrefix.length);
              return run(actors(new Request(stripped, request)));
            }
            return run(
              Effect.map(
                Effect.orDie(document),
                (html) => new Response(html, { headers: { "content-type": "text/html" } }),
              ),
            );
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );
    const port = Option.getOrElse(Option.fromNullishOr(server.port), () => 0);
    const served: Served = { url: `http://127.0.0.1:${String(port)}`, wire, context };
    return served;
  });

const serve = serveWith([Tasks], page);

interface Reply {
  readonly status: number;
  readonly location: string;
  readonly body: string;
}

const request = (url: string, init: RequestInit) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetch(url, { ...init, redirect: "manual" }));
    const body = yield* Effect.promise(() => response.text());
    const reply: Reply = {
      status: response.status,
      location: Option.getOrElse(Option.fromNullishOr(response.headers.get("location")), () => ""),
      body,
    };
    return reply;
  });

const getPage = (served: Served) => Effect.map(request(served.url, {}), (reply) => reply.body);

/** Post a form body the way a browser does with no script. */
const post = (served: Served, body: string) =>
  request(`${served.url}${actorPrefix}/form`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

/** Post a body under any content type. */
const postAs = (served: Served, contentType: string, body: string) =>
  request(`${served.url}${actorPrefix}/form`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });

/** The rendered `add` form, filled: hidden inputs first, then the typed fields. */
const fill = (html: string, typed: ReadonlyArray<[string, string]>): string =>
  fillForm(html, "add", typed);

/** Any rendered form, filled. */
const fillForm = (html: string, formId: string, typed: ReadonlyArray<[string, string]>): string =>
  Form.toBody(Form.fromEntries([...hiddenOf(html, formId), ...typed]));

/** The body with one field's value replaced. */
const withField = (body: string, name: string, value: string): string =>
  Form.toBody(Form.withValues(Form.fromBody(body), [[name, value]]));

/**
 * The actor's committed state at `revision`, read through the same host.
 * The 303 follows the commit (`plain-commit.test.tsx`), so the read finds it;
 * the wait bounds a read of a later revision.
 */
const snapshot = (served: Served, revision = 0) =>
  Effect.scoped(
    Effect.flatMap(Actor.remote(Tasks, board), (tasks) =>
      Stream.runHead(
        Stream.filter(tasks.applied.changes, (applied) => applied.revision.value >= revision),
      ),
    ),
  ).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.timeout("2 seconds"),
    Effect.orDie,
    Effect.provideContext(served.context),
  );

const sends = (served: Served) => Ref.get(served.wire.sends);

/** The `Vault` actor's committed state at `revision`, read through the same host. */
const vaultAt = (served: Served, revision: number) =>
  Effect.scoped(
    Effect.flatMap(Actor.remote(Vault, vaultKey), (vaults) =>
      Stream.runHead(
        Stream.filter(vaults.applied.changes, (applied) => applied.revision.value >= revision),
      ),
    ),
  ).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.timeout("2 seconds"),
    Effect.orDie,
    Effect.provideContext(served.context),
  );

/**
 * A form message whose codec is not repeatable: a decoding default draws
 * a new value on every decode. #32 forbids this for a form; the route
 * refuses it rather than send bytes a resubmission cannot repeat.
 */
const draws = { next: 0 };

const Stamp = Schema.TaggedStruct("Stamp", {
  title: Schema.String,
  nonce: Schema.String.pipe(
    Schema.withDecodingDefaultKey(
      Effect.sync(() => {
        draws.next += 1;
        return String(draws.next);
      }),
    ),
  ),
});

const Stamps = contract("Stamps", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ id: Schema.String }),
  snapshot: Schema.Struct({ count: Schema.Finite }),
  message: Schema.Union([Stamp]),
});

const sendAt = (served: Served, index: number) =>
  Effect.map(sends(served), (seen) => Option.getOrThrow(Option.fromNullishOr(seen[index])));

describe("plain-form posts", () => {
  it.scopedLive("a urlencoded post to /actors/form applies the message and answers 303", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const commandId = hiddenValue(html, "add", "$command");

      const reply = yield* post(
        served,
        fill(html, [
          ["title", "milk"],
          ["done", "on"],
        ]),
      );

      expect(reply.status).toBe(303);
      expect(reply.location).toBe("/");
      const applied = yield* snapshot(served, 1);
      expect(applied.state.tasks).toEqual([{ id: commandId, title: "milk", done: true }]);
      expect((yield* sends(served)).map((send) => String(send.commandId))).toEqual([commandId]);
    }),
  );

  it.scopedLive("the identical body posted twice returns the stored receipt and one revision", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const body = fill(html, [["title", "milk"]]);

      const first = yield* post(served, body);
      const second = yield* post(served, body);

      expect([first.status, second.status]).toEqual([303, 303]);
      const applied = yield* snapshot(served, 1);
      expect(applied.revision.value).toBe(1);
      expect(applied.state.tasks).toHaveLength(1);
      // An unchecked box sent nothing, and nothing decoded it as anything but false.
      expect(applied.state.tasks[0]?.done).toBe(false);
      // Both posts reached the transport under one id; the mailbox applied one.
      const ids = (yield* sends(served)).map((send) => send.commandId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(1);
    }),
  );

  it.scopedLive("a bad value answers 200 with the page, the issues, and the submitted fields", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const posted = hiddenValue(html, "add", "$command");

      const reply = yield* post(
        served,
        fill(html, [
          ["title", "far too long a title"],
          ["done", "on"],
          ["_pin", "4321"],
        ]),
      );

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('<li data-field="title">');
      expect(reply.body).toContain(
        '<input id="title" name="title" value="far too long a title" aria-invalid="true">',
      );
      expect(reply.body).toContain('<input id="done" type="checkbox" name="done" checked>');
      // A field whose segment starts with `_` never round-trips into markup.
      expect(reply.body).not.toContain("4321");
      expect(reply.body).toContain('<input id="pin" name="_pin">');
      // The refused id never reached a mailbox; the page carries a fresh one.
      const next = hiddenValue(reply.body, "add", "$command");
      expect(next).not.toBe(posted);
      expect(hiddenValue(reply.body, "add", "id")).toBe(next);
      expect(yield* sends(served)).toEqual([]);
    }),
  );

  it.scopedLive("a post the behavior refuses answers 422 with its reason and applies nothing", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const posted = hiddenValue(html, "add", "$command");

      const reply = yield* post(served, fill(html, [["title", refusedTitle]]));

      expect(reply.status).toBe(422);
      expect(reply.body).toContain("that title is refused");
      // The same bytes are refused every time: the page carries a fresh id.
      expect(hiddenValue(reply.body, "add", "$command")).not.toBe(posted);
      const again = yield* post(served, fill(html, [["title", refusedTitle]]));
      expect(again.status).toBe(422);
      const corrected = yield* post(served, fill(reply.body, [["title", "short"]]));
      expect(corrected.status).toBe(303);
      // Only the corrected post committed: it is revision 1.
      const applied = yield* snapshot(served, 1);
      expect(applied.revision.value).toBe(1);
      expect(applied.state.tasks.map((task) => task.title)).toEqual(["short"]);
    }),
  );

  it.scopedLive("the corrected resubmission applies and does not raise CommandConflict", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const refused = yield* post(served, fill(html, [["title", "far too long a title"]]));
      const next = hiddenValue(refused.body, "add", "$command");

      const corrected = yield* post(served, fill(refused.body, [["title", "short"]]));

      expect(corrected.status).toBe(303);
      const applied = yield* snapshot(served, 1);
      expect(applied.state.tasks).toEqual([{ id: next, title: "short", done: false }]);
    }),
  );

  it.scopedLive("the 504 re-render posts the same message and hits the stored receipt", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const posted = hiddenValue(html, "add", "$command");
      const body = fill(html, [["title", "milk"]]);
      yield* Ref.set(served.wire.loseNextReply, true);

      const lost = yield* post(served, body);

      expect(lost.status).toBe(504);
      // The command may have reached the mailbox, so the id and the generated value stay.
      expect(hiddenValue(lost.body, "add", "$command")).toBe(posted);
      expect(hiddenValue(lost.body, "add", "id")).toBe(posted);
      const resubmit = fill(lost.body, [["title", "milk"]]);
      // The redraw adds only the `$uncertain` marker; every other field is byte-identical.
      expect(hiddenValue(lost.body, "add", "$uncertain")).toBe("true");
      expect(Form.toBody(Form.without(Form.fromBody(resubmit), ["$uncertain"]))).toBe(body);

      const retried = yield* post(served, resubmit);

      expect(retried.status).toBe(303);
      // The route sent the same payload bytes both times: the receipt's hash and text match.
      expect((yield* sendAt(served, 1)).payload).toBe((yield* sendAt(served, 0)).payload);
      const applied = yield* snapshot(served, 1);
      expect(applied.revision.value).toBe(1);
      expect(applied.state.tasks).toEqual([{ id: posted, title: "milk", done: false }]);
    }),
  );

  it.scopedLive("a protocol-relative $return answers 400 and the actor is untouched", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const hostile = Form.toBody(
        Form.withValues(Form.fromBody(fill(html, [["title", "milk"]])), [
          ["$return", "//evil.test/"],
        ]),
      );
      const absolute = Form.toBody(
        Form.withValues(Form.fromBody(fill(html, [["title", "milk"]])), [
          ["$return", "https://evil.test/"],
        ]),
      );

      const refused = yield* post(served, hostile);
      const alsoRefused = yield* post(served, absolute);

      expect([refused.status, alsoRefused.status]).toEqual([400, 400]);
      expect(refused.location).toBe("");
      expect(yield* sends(served)).toEqual([]);
      expect((yield* snapshot(served)).revision.value).toBe(0);
    }),
  );

  it.scopedLive("a multipart body answers 415", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const body = new FormData();
      for (const [name, value] of Form.toEntries(Form.fromBody(fill(html, [["title", "milk"]])))) {
        body.append(name, value);
      }

      const reply = yield* request(`${served.url}${actorPrefix}/form`, { method: "POST", body });

      expect(reply.status).toBe(415);
      expect(reply.body).toContain("multipart/form-data is not accepted");
      expect(yield* sends(served)).toEqual([]);
    }),
  );

  it.scopedLive("a hostile field name is refused before the message schema is consulted", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);

      const reply = yield* post(served, fill(html, [["__proto__.title", "milk"]]));

      expect(reply.status).toBe(400);
      expect(yield* sends(served)).toEqual([]);
    }),
  );

  it.scopedLive(
    "a $return that a URL parser reads as another origin answers 400 and sends nothing",
    () =>
      Effect.gen(function* () {
        const served = yield* serve;
        const html = yield* getPage(served);
        const body = fill(html, [["title", "milk"]]);
        const hostile = [
          "/\t/evil.test/",
          "/\n/evil.test/",
          "/\r/evil.test/",
          "/\t\\evil.test",
          "/\\evil.test",
          "//evil.test",
          "https://evil.test/",
          "/a\nb",
          "/a b",
          "/\u007f",
          "/caf\u00e9",
          "",
        ];

        for (const returnTo of hostile) {
          const reply = yield* post(served, withField(body, "$return", returnTo));
          expect([returnTo, reply.status, reply.location]).toEqual([returnTo, 400, ""]);
        }

        // No refusal reached the transport: each one was answered before the send.
        expect(yield* sends(served)).toEqual([]);
        expect((yield* snapshot(served)).revision.value).toBe(0);
      }),
  );

  it.scopedLive("an encoded slash or backslash in $return stays a path on this origin", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);
      const body = fill(html, [["title", "milk"]]);

      for (const returnTo of ["/%2f%2fevil.test/", "/%2F%2Fevil.test/", "/%5c%5cevil.test/"]) {
        const reply = yield* post(served, withField(body, "$return", returnTo));
        expect(reply.status).toBe(303);
        expect(reply.location).toBe(returnTo);
        expect(new URL(reply.location, served.url).origin).toBe(new URL(served.url).origin);
      }
    }),
  );

  it.scopedLive(
    "the media type is read without case, and a charset other than UTF-8 answers 415",
    () =>
      Effect.gen(function* () {
        const served = yield* serve;
        const html = yield* getPage(served);
        const body = fill(html, [["title", "milk"]]);

        const latin = yield* postAs(
          served,
          "application/x-www-form-urlencoded; charset=ISO-8859-1",
          body,
        );
        expect(latin.status).toBe(415);
        expect(yield* sends(served)).toEqual([]);

        const mixed = yield* postAs(
          served,
          'Application/X-WWW-Form-Urlencoded; Charset="UTF-8"',
          body,
        );
        expect(mixed.status).toBe(303);
      }),
  );

  it.scopedLive("a very deep field name or a mixed list answers 400 before any send", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);

      const deep = Array.from({ length: 20_000 }, () => "a").join(".");
      const tooDeep = yield* post(
        served,
        fill(html, [
          ["title", "milk"],
          [deep, "x"],
        ]),
      );
      const mixed = yield* post(
        served,
        fill(html, [
          ["title", "milk"],
          ["tags[1]", "x"],
          ["tags[]", "y"],
        ]),
      );

      expect([tooDeep.status, mixed.status]).toEqual([400, 400]);
      expect(yield* sends(served)).toEqual([]);
    }),
  );

  it.scopedLive("two forms on one key refuse separately", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);

      const refused = yield* post(served, fill(html, [["title", "far too long a title"]]));

      expect(refused.status).toBe(200);
      const add = hiddenValue(refused.body, "add", "$command");
      const tag = hiddenValue(refused.body, "tag", "$command");
      // The Tag form is not the one refused: it keeps its own identity and values.
      expect(tag).not.toBe(add);
      expect(hiddenValue(refused.body, "tag", "id")).not.toBe(add);
      expect(hiddenValue(refused.body, "tag", "$form")).toBe("Tag");
      const tagForm = refused.body.slice(refused.body.indexOf('<form id="tag"'));
      expect(tagForm.slice(0, tagForm.indexOf("</form>"))).not.toContain("aria-invalid");
      expect(refused.body).toContain(Form.issuesScriptId);

      // The Tag form posts from the refused page and applies; it does not conflict.
      const tagged = yield* post(served, fillForm(refused.body, "tag", [["label", "home"]]));
      expect(tagged.status).toBe(303);
      const applied = yield* snapshot(served, 1);
      expect(applied.state.tags).toEqual([
        { id: hiddenValue(refused.body, "tag", "id"), label: "home" },
      ]);
    }),
  );
  it.scopedLive("an equal-hash payload under a posted id answers 409 and applies nothing new", () =>
    Effect.gen(function* () {
      const served = yield* serve;
      const html = yield* getPage(served);

      const first = yield* post(served, fill(html, [["title", "00008t"]]));
      expect(first.status).toBe(303);
      yield* snapshot(served, 1);
      const second = yield* post(served, fill(html, [["title", "0000fj"]]));

      // The two payloads differ and share a hash, so only the text tells them apart.
      const [a, b] = [yield* sendAt(served, 0), yield* sendAt(served, 1)];
      expect(a.commandId).toBe(b.commandId);
      expect(a.payload).not.toBe(b.payload);
      expect(Hash.string(a.payload)).toBe(Hash.string(b.payload));
      expect(second.status).toBe(409);
      const applied = yield* snapshot(served, 1);
      expect(applied.revision.value).toBe(1);
      expect(applied.state.tasks.map((task) => task.title)).toEqual(["00008t"]);
    }),
  );

  it.scopedLive("a form message that decodes to two payloads answers 500 and sends nothing", () =>
    Effect.gen(function* () {
      const served = yield* serveWith([Stamps], Effect.succeed("<p>page</p>"));
      const body = Form.toBody(
        Form.fromEntries([
          ["$command", String(yield* Form.freshCommandId)],
          ["$contract", "Stamps"],
          ["$version", "1"],
          ["$key", yield* Form.encodeKey(Stamps, { id: "a" })],
          ["$return", "/"],
          ["$form", "Stamp"],
          ["_tag", "Stamp"],
          ["title", "x"],
        ]),
      );

      const reply = yield* post(served, body);

      expect(reply.status).toBe(500);
      expect(reply.body).toContain("does not decode repeatably");
      expect(yield* sends(served)).toEqual([]);
    }),
  );

  it.scopedLive(
    "a 504 page resubmitted without its redacted pin keeps the id and admits nothing new",
    () =>
      Effect.gen(function* () {
        const served = yield* serveWith([Vault], VaultDocument);
        const html = yield* getPage(served);
        const posted = hiddenValue(html, "unlock", "$command");
        yield* Ref.set(served.wire.loseNextReply, true);

        const lost = yield* post(
          served,
          fillForm(html, "unlock", [
            ["label", "door"],
            ["_pin", "4321"],
          ]),
        );

        expect(lost.status).toBe(504);
        expect(hiddenValue(lost.body, "unlock", "$command")).toBe(posted);
        expect(hiddenValue(lost.body, "unlock", "$uncertain")).toBe("true");
        // A redacted value is never written back, so the pin must be typed again.
        expect(lost.body).not.toContain("4321");
        yield* vaultAt(served, 1);

        // Posted as redrawn: the pin is missing. The issue names it, and the id stays.
        const missing = yield* post(served, fillForm(lost.body, "unlock", [["label", "door"]]));
        expect(missing.status).toBe(200);
        expect(missing.body).toContain('<li data-field="_pin">');
        expect(hiddenValue(missing.body, "unlock", "$command")).toBe(posted);
        expect(hiddenValue(missing.body, "unlock", "$uncertain")).toBe("true");
        expect(yield* sends(served)).toHaveLength(1);

        // The same pin typed again: the stored receipt, one application.
        const retyped = yield* post(
          served,
          fillForm(missing.body, "unlock", [
            ["label", "door"],
            ["_pin", "4321"],
          ]),
        );
        expect(retyped.status).toBe(303);

        // Another pin under that id is a conflict, never a second application.
        const other = yield* post(
          served,
          fillForm(missing.body, "unlock", [
            ["label", "door"],
            ["_pin", "9999"],
          ]),
        );
        expect(other.status).toBe(409);
        expect(hiddenValue(other.body, "unlock", "$command")).not.toBe(posted);
        expect(hiddenValue(other.body, "unlock", "$uncertain")).toBe("");

        const replies = yield* Ref.get(served.wire.replies);
        expect(replies.map((reply) => reply.admitted)).toEqual([1, 1]);
        const applied = yield* vaultAt(served, 1);
        expect(applied.revision.value).toBe(1);
        expect(applied.state.unlocks).toEqual(["door"]);
      }),
  );
});
