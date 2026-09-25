/* oxlint-disable effect/noAsyncFunction, effect/noTestLifecycleHooks, effect/noTryCatch, no-await-in-loop -- this proof drives real WebKit and Chrome pages through Bun.WebView, over one Blog server the file shares. */
/**
 * The island's first scripted heart, in real browsers: the real Blog
 * server, a build with the real client bundle, and a built post. The form's
 * `id` was minted by the server into the built page; hydration adopts it,
 * and an adopted id counts as supplied, so the first press is not predicted.
 * It is sent over the transport, the page does not navigate, and the count
 * moves once the server confirms it. The harness is the Notes one, with its
 * CI rule: under CI, a missing Chrome fails the file.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Scope } from "effect";
import type { Engine } from "../../notes/tests/browser.js";
import { hasNavigation, open, waitFor } from "../../notes/tests/browser.js";
import { routes } from "../src/routes.js";
import { bundleClient } from "../src/prerender.server.js";
import { buildInto, reservedPorts, serverOver, storeOf, workspace } from "./fixture.js";

const engines: ReadonlyArray<Engine> = ["chrome", "webkit"];

/** One post per engine: each starts with no hearts. */
const postOf = { chrome: "second-wind", webkit: "third-time" } satisfies Record<Engine, string>;

/** A built Blog, with the real bundle, served on a free port. */
const start = Effect.gen(function* () {
  const site = yield* workspace();
  const store = yield* storeOf(site.posts);
  yield* buildInto(store, site.out, routes, bundleClient);
  return yield* serverOver(store, site.out);
});

// One server for the file, in `scope`. The proof's own entry point: the
// build and the server read real files.
const scope = Effect.runSync(Scope.make());
const server = await Effect.runPromise(
  // @effect-diagnostics-next-line strictEffectProvide:off
  Scope.provide(start, scope).pipe(Effect.provide(BunServices.layer)),
);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const available = new Map<Engine, boolean>();
for (const engine of engines) {
  available.set(engine, await hasNavigation(engine, server.url));
}

const hearts = `document.getElementById("hearts").textContent`;

for (const engine of engines) {
  describe.skipIf(available.get(engine) !== true)(`the Blog island in ${engine}`, () => {
    it("the first scripted heart goes over the transport and counts once the server confirms it", async () => {
      expect(reservedPorts).not.toContain(server.port);
      const slug = postOf[engine];
      const view = await open(engine, `${server.url}/posts/${slug}`);
      try {
        await waitFor(view, `document.documentElement.dataset.hydrated === "true"`, "hydrated");
        expect(await view.evaluate<string>(hearts)).toBe("0");
        // A marker on the window: a form post would navigate and drop it.
        await view.evaluate(`(window.stayed = true, true)`);
        await view.evaluate(`(document.getElementById("heart-button").click(), true)`);
        await waitFor(view, `${hearts} === "1"`, "the first heart");
        expect(await view.evaluate<boolean>(`window.stayed === true`)).toBe(true);
        expect(await view.evaluate<string>(`location.pathname`)).toBe(`/posts/${slug}`);

        // A second press counts too: the first did not spend the form.
        await view.evaluate(`(document.getElementById("heart-button").click(), true)`);
        await waitFor(view, `${hearts} === "2"`, "the second heart");
        expect(await view.evaluate<boolean>(`window.stayed === true`)).toBe(true);
      } finally {
        view.close();
      }
    }, 20_000);
  });
}
