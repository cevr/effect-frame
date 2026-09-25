import { Deferred, Effect, Ref, Scope, Stream } from "effect";
import type { Scope as ScopeType } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { DocumentTimedOut, respondDocument } from "effect-frame/router";
import type { DocumentOutcome } from "effect-frame/router";
import { HttpServerResponse } from "effect/unstable/http";
import { webOf } from "../web.js";

/** A render that records when the Scope it was given closes. */
const recording = (closed: Ref.Ref<boolean>, outcome: DocumentOutcome<never>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    yield* Scope.addFinalizer(scope, Ref.set(closed, true));
    return outcome;
  });

const onTimeout = () => Effect.succeed(HttpServerResponse.text("late", { status: 504 }));

/** Answer one GET of `path` with the document `render` prepares, as a server would. */
const answer = <A>(
  render: (url: URL) => Effect.Effect<DocumentOutcome<A>, DocumentTimedOut, ScopeType.Scope>,
  path = "/",
) =>
  Effect.flatMap(webOf(respondDocument(render, { onTimeout })), (web) =>
    web(new Request(`http://site.test${path}`)),
  );

const rendered = (body: Stream.Stream<string>): DocumentOutcome<never> => ({
  _tag: "Rendered",
  route: { _tag: "NotFound" },
  mode: "Streamed",
  status: 200,
  body,
});

describe("respondDocument owns the render's Scope", () => {
  it.effect("renders the URL the request names", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make("");
      yield* answer(
        (url) =>
          Effect.as(Ref.set(seen, `${url.pathname}${url.search}`), rendered(Stream.make("ok"))),
        "/notes/n1?tab=2",
      );
      expect(yield* Ref.get(seen)).toBe("/notes/n1?tab=2");
    }),
  );

  it.effect("a redirect answers 303 with the path and search, and closes the Scope", () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false);
      const response = yield* answer(() =>
        recording(closed, {
          _tag: "Redirect",
          location: new URL("http://site.test/login?next=%2Fdrafts"),
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login?next=%2Fdrafts");
      expect(yield* Ref.get(closed)).toBe(true);
    }),
  );

  it.effect("a document keeps its Scope open until the body ends", () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false);
      // The body's last chunk waits, so the body has not ended when the answer leaves.
      const last = yield* Deferred.make<string>();
      const body = Stream.concat(Stream.make("<p>", "hi"), Stream.fromEffect(Deferred.await(last)));
      const response = yield* answer(() => recording(closed, rendered(body)));
      expect(yield* Ref.get(closed)).toBe(false);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      yield* Deferred.succeed(last, "</p>");
      const text = yield* Effect.promise(() => response.text());
      expect(text).toBe("<p>hi</p>");
      expect(yield* Ref.get(closed)).toBe(true);
    }),
  );

  it.effect("a timeout answers what onTimeout names", () =>
    Effect.gen(function* () {
      const response = yield* answer(() => Effect.fail(DocumentTimedOut.make({ phase: "settle" })));
      expect(response.status).toBe(504);
    }),
  );

  it.effect("a defect closes the Scope and answers 500", () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false);
      const response = yield* answer(() =>
        Effect.andThen(recording(closed, rendered(Stream.empty)), Effect.die("the drawing broke")),
      );
      expect(response.status).toBe(500);
      expect(yield* Ref.get(closed)).toBe(true);
    }),
  );
});
