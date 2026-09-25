import { Effect, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { DocumentTimedOut, respondDocument } from "effect-frame/router";
import type { DocumentOutcome } from "effect-frame/router";

/** A render that records when the Scope it was given closes. */
const recording = (closed: Ref.Ref<boolean>, outcome: DocumentOutcome<never>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    yield* Scope.addFinalizer(scope, Ref.set(closed, true));
    return outcome;
  });

const onTimeout = () => Effect.succeed(new Response("late", { status: 504 }));

const rendered = (body: Stream.Stream<string>): DocumentOutcome<never> => ({
  _tag: "Rendered",
  route: { _tag: "NotFound" },
  mode: "Streamed",
  status: 200,
  body,
});

describe("respondDocument owns the render's Scope", () => {
  it.effect("a redirect answers 303 with the path and search, and closes the Scope", () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false);
      const response = yield* respondDocument(
        recording(closed, {
          _tag: "Redirect",
          location: new URL("http://site.test/login?next=%2Fdrafts"),
        }),
        { onTimeout },
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login?next=%2Fdrafts");
      expect(yield* Ref.get(closed)).toBe(true);
    }),
  );

  it.effect("a document keeps its Scope open until the body ends", () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false);
      const response = yield* respondDocument(
        recording(closed, rendered(Stream.make("<p>", "hi", "</p>"))),
        { onTimeout },
      );
      expect(yield* Ref.get(closed)).toBe(false);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const text = yield* Effect.promise(() => response.text());
      expect(text).toBe("<p>hi</p>");
      expect(yield* Ref.get(closed)).toBe(true);
    }),
  );

  it.effect("a timeout answers what onTimeout names", () =>
    Effect.gen(function* () {
      const response = yield* respondDocument(
        Effect.fail(DocumentTimedOut.make({ phase: "settle" })),
        { onTimeout },
      );
      expect(response.status).toBe(504);
    }),
  );

  it.effect("a defect closes the Scope and answers 500", () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false);
      const response = yield* respondDocument(
        Effect.andThen(recording(closed, rendered(Stream.empty)), Effect.die("the drawing broke")),
        { onTimeout },
      );
      expect(response.status).toBe(500);
      expect(yield* Ref.get(closed)).toBe(true);
    }),
  );
});
