import type { DocumentOutcome } from "effect-frame/router";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { answerWith } from "../src/server.js";

/**
 * The page request's Scope (counsel round 1, item 3). The Scope is kept
 * past the answer only for a returned body, and closes when that body ends.
 * A defect in the drawing closes it before the 500 leaves, and so does a
 * redirect.
 */

const request = new Request("http://dashboard.test/d/acme");

/** A render that holds one finalizer in the request Scope, then does `then`. */
const holding =
  <A, E>(finalized: Array<string>, then: Effect.Effect<A, E>) =>
  () =>
    Effect.addFinalizer(() => Effect.sync(() => finalized.push("closed"))).pipe(
      Effect.andThen(then),
    );

describe("a page request's Scope", () => {
  it.effect("a defect in the drawing closes the Scope and answers 500", () =>
    Effect.gen(function* () {
      const finalized: Array<string> = [];
      const response = yield* answerWith(holding(finalized, Effect.die("drawing broke")))(request);
      expect(response.status).toBe(500);
      expect(finalized).toEqual(["closed"]);
    }),
  );

  it.effect("a redirect closes the Scope before it answers", () =>
    Effect.gen(function* () {
      const finalized: Array<string> = [];
      const response = yield* answerWith(
        holding(
          finalized,
          Effect.succeed<DocumentOutcome<unknown>>({
            _tag: "Redirect",
            location: new URL("http://dashboard.test/d/acme"),
          }),
        ),
      )(request);
      expect(response.status).toBe(303);
      expect(finalized).toEqual(["closed"]);
    }),
  );

  it.effect("a returned body keeps the Scope until the body ends", () =>
    Effect.gen(function* () {
      const finalized: Array<string> = [];
      const page: DocumentOutcome<unknown> = {
        _tag: "Rendered",
        route: { _tag: "NotFound" },
        mode: "SSR",
        status: 200,
        body: Stream.make("<p>", "drawn", "</p>"),
      };
      const response = yield* answerWith(holding(finalized, Effect.succeed(page)))(request);
      expect(finalized).toEqual([]);
      const text = yield* Effect.promise(() => response.text());
      expect(text).toBe("<p>drawn</p>");
      expect(finalized).toEqual(["closed"]);
    }),
  );
});
