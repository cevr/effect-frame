import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { repeatedTerms } from "../src/glossary";

/**
 * The glossary rule's reading: `CONTEXT.md` defines each term once, as a
 * bold `**Term**:` line. The repository's own glossary is checked by
 * `bun run docs`, which the gate runs.
 */

describe("glossary rule", () => {
  it.effect("names a term defined twice, at the second definition", () =>
    Effect.sync(() => {
      const glossary = [
        "**Server module**:",
        "A file that may run only on a server.",
        "",
        "**Browser entry**:",
        "A file a bundler compiles for a page.",
        "",
        "**Server module**:",
        "The same file again.",
      ].join("\n");
      expect(repeatedTerms(glossary)).toEqual([{ term: "Server module", line: 7, first: 1 }]);
    }),
  );

  it.effect("reads a bold word inside a definition as prose, not a term", () =>
    Effect.sync(() => {
      const glossary = [
        "**Route**:",
        "A named tree. See **Segment** and **Segment**.",
        "",
        "**Segment**:",
        "An address.",
      ].join("\n");
      expect(repeatedTerms(glossary)).toEqual([]);
    }),
  );
});
