import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { host } from "../../examples/counter/counter.server.js";
import { actorHandler, answerPage } from "../../examples/counter/page.server.js";

/**
 * The first app of the package README (`examples/counter`), run as its
 * server runs it: one host, the page answer, and the actor handler. The
 * README's code blocks are these files, so a README that stops working
 * fails here.
 */

const origin = "http://counter.test";

const get = (path: string) =>
  Effect.flatMap(answerPage(new Request(`${origin}${path}`)), (response) =>
    Effect.map(
      Effect.promise(() => response.text()),
      (text) => ({ status: response.status, location: response.headers.get("location"), text }),
    ),
  );

/** Every input the page's form draws, as the browser would post them. */
const fieldsOf = (html: string): URLSearchParams => {
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  const fields = new URLSearchParams();
  for (const input of form.matchAll(/<input [^>]*>/g)) {
    const name = Option.fromNullishOr(/name="([^"]*)"/.exec(input[0])?.[1]);
    const value = Option.fromNullishOr(/value="([^"]*)"/.exec(input[0])?.[1]);
    Option.map(name, (found) =>
      fields.append(
        found,
        Option.getOrElse(value, () => ""),
      ),
    );
  }
  return fields;
};

/** The count a page shows. */
const countOf = (html: string): string => /count: (?:<!---->)?(\d+)/.exec(html)?.[1] ?? "";

describe("the README's first app", () => {
  const withHost = it.effect.layer(host);

  withHost("draws a counter page on the server, with the names beside it", () =>
    Effect.gen(function* () {
      const page = yield* get("/counters/home");
      expect(page.status).toBe(200);
      expect(page.text).toContain('<div id="app">');
      expect(page.text).toContain("<h1>home</h1>");
      expect(countOf(page.text)).toBe("0");
      expect(page.text).toContain('href="/counters/work"');
      // Only the link to the page shown is the current page.
      expect(page.text).toMatch(/<a [^>]*href="\/counters\/home"[^>]*aria-current="page"/);
      expect(page.text).not.toMatch(/<a [^>]*href="\/counters\/work"[^>]*aria-current/);
    }),
  );

  withHost("sends / to the home counter before anything draws", () =>
    Effect.gen(function* () {
      const page = yield* get("/");
      expect(page.status).toBe(303);
      expect(page.location).toBe("/counters/home");
    }),
  );

  withHost("adds through a plain form post with no script, and returns to the page", () =>
    Effect.gen(function* () {
      const actors = yield* actorHandler;
      const before = yield* get("/counters/work");
      const fields = fieldsOf(before.text);
      fields.set("by", "5");
      const posted = yield* actors(
        new Request(`${origin}/actors/form`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: fields.toString(),
        }),
      );
      expect(posted.status).toBe(303);
      expect(posted.headers.get("location")).toBe("/counters/work");
      const after = yield* get("/counters/work");
      expect(countOf(after.text)).toBe("5");
    }),
  );
});
