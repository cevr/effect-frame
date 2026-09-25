// oxlint-disable effect/noGlobals -- the test reads the real page source to inject a leak into it.
import { checkEntry, formatViolation } from "@effect-frame/toolchain-checks/boundary";
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * #24 in the Blog: one injected import of `posts.server.js` in the post page
 * is refused with the chain of files that reached it, and it is the only
 * refusal, so nothing else the entry reaches (the posts, the host, the build)
 * is server code. `bun run boundary` in the gate checks the entry as written.
 */

/** The source directory, with no trailing slash, as `formatViolation` takes a root. */
const source = new URL("../src", import.meta.url).pathname;
const client = `${source}/client.tsx`;
const page = `${source}/page.tsx`;

describe("the Blog browser entry and its server modules (#24)", () => {
  it.effect("an import of posts.server.js in page.tsx is refused with its path chain", () =>
    Effect.gen(function* () {
      const written = yield* Effect.promise(() => Bun.file(page).text());
      const leak = [`import "./posts.server.js";`, written].join("\n");
      const violations = yield* checkEntry(client, [{ path: page, contents: leak }]);
      expect(violations.map((violation) => formatViolation(violation, source))).toEqual([
        [
          "refused a server module (*.server.*):",
          "  ./client.tsx",
          "    -> ./routes.tsx",
          "      -> ./page.tsx",
          "        -> ./posts.server.js",
        ].join("\n"),
      ]);
    }),
  );
});
