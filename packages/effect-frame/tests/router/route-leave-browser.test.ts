/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noThrowStatement, effect/noNewError, effect/noTryCatch, no-await-in-loop -- this proof drives real WebKit and Chrome pages through Bun.WebView. */
/**
 * Route slice 5, real-browser proofs. The fixture page mounts the real
 * router on the private `browserCommit` Location; one post view registers a
 * leave check. See `docs/design/route-leave.md` for the observed engine
 * support. A fake pop stream proves none of these facts.
 */
import { describe, expect, it } from "bun:test";
import * as H from "./browser/harness.js";

/** Each engine, probed once before the proofs are declared. Absent: undefined. */
const chrome = await H.capabilities("chrome");
const webkit = await H.capabilities("webkit");

/** One bundle for the file, built when the first proof needs it. */
let bundled: Promise<string> | undefined;
const bundleOnce = (): Promise<string> => {
  bundled ??= H.bundle();
  return bundled;
};

/** Each page owns its server, so `closePage` stops both. */
const servers = new WeakMap<Bun.WebView, H.PageServer>();

/** Serve and open the fixture at `path`, and wait until the router shows it. */
const openAt = async (
  engine: H.Engine,
  path: string,
  precommit: "detect" | "off" = "detect",
): Promise<Bun.WebView> => {
  const server = await H.serve(await bundleOnce());
  server.config = { precommit };
  const view = await H.open(engine, `${server.origin}${path}`);
  servers.set(view, server);
  await H.waitFor(view, "window.__leave && window.__leave.ready", "the router mounted");
  return view;
};

const closePage = (view: Bun.WebView): void => {
  view.close();
  servers.get(view)?.stop();
};

const read = <A>(view: Bun.WebView, expression: string): Promise<A> => view.evaluate<A>(expression);

const shows = (view: Bun.WebView, postId: string, tab = "read") =>
  H.waitFor(
    view,
    `location.pathname === "/app/t1/posts/${postId}" && document.querySelector("#post-param")?.textContent === "${postId}" && document.querySelector("#post-tab")?.textContent === "${tab}"`,
    `post ${postId}?${tab} shown`,
  );

/** Everything a Stay must keep: URL, entry, element, draft, focus, caret. */
interface Kept {
  readonly path: string;
  readonly index: number | null;
  readonly sameElement: boolean;
  readonly param: string;
  readonly draft: string;
  readonly focused: string;
  readonly caret: readonly [number, number];
}

const kept = (view: Bun.WebView): Promise<Kept> =>
  read<Kept>(
    view,
    `(() => {
      const draft = document.querySelector("#draft");
      return {
        path: location.pathname + location.search,
        index: window.navigation ? navigation.currentEntry.index : null,
        sameElement: document.querySelector("#post") === window.__marked,
        param: document.querySelector("#post-param").textContent,
        draft: draft.value,
        focused: document.activeElement ? document.activeElement.id : "",
        caret: [draft.selectionStart, draft.selectionEnd],
      };
    })()`,
  );

/** Type into the draft with real input events, then place the caret. */
const typeDraft = async (view: Bun.WebView, text: string): Promise<void> => {
  await view.click("#draft");
  await view.type(text);
  await read(view, `(document.querySelector("#draft").setSelectionRange(1, 3), true)`);
  await read(view, `(window.__marked = document.querySelector("#post"), true)`);
};

const setMode = (view: Bun.WebView, mode: "leave" | "stay" | "held") =>
  read(view, `(window.__leave.mode = "${mode}", true)`);

const asked = (view: Bun.WebView) => read<ReadonlyArray<string>>(view, "window.__leave.asked");

const logs = (view: Bun.WebView) => read<ReadonlyArray<string>>(view, "window.__leave.logs");

const navigate = (view: Bun.WebView, href: string) =>
  read<string>(view, `window.__leave.navigate(${JSON.stringify(href)})`);

/** Wait until the page has sent `count` questions, then a settle margin. */
const askedCount = (view: Bun.WebView, count: number) =>
  H.waitFor(view, `window.__leave.asked.length === ${String(count)}`, `${String(count)} questions`);

/** A Stay leaves nothing to wait for; give the platform a moment to prove it did nothing. */
const settleMargin = () => Bun.sleep(150);

// ---------------------------------------------------------------------------
// Chrome: the Navigation API with a precommit handler
// ---------------------------------------------------------------------------

/** The capability the fixture page itself sees; the proofs branch on the probe. */
const pageCapabilities = (view: Bun.WebView) =>
  read<{ readonly navigation: boolean; readonly precommit: boolean }>(
    view,
    `({ navigation: "navigation" in window, precommit: "NavigationPrecommitController" in window })`,
  );

describe.skipIf(chrome === undefined)("leave checks in Chrome", () => {
  it("records the engine's capabilities", async () => {
    console.log(`chrome capability: ${JSON.stringify(chrome)}`);
    const view = await openAt("chrome", "/app/t1/posts/1");
    try {
      // The fixture page sees what the probe recorded, and this suite needs the API.
      expect(await pageCapabilities(view)).toEqual({
        navigation: chrome?.navigation ?? false,
        precommit: chrome?.precommit ?? false,
      });
      expect(chrome?.navigation).toBe(true);
    } finally {
      closePage(view);
    }
  }, 30_000);

  it.skipIf(chrome?.precommit !== true)(
    "Back and Forward: a precommit Stay keeps everything; Leave commits once",
    async () => {
      const view = await openAt("chrome", "/app/t1/posts/1");
      try {
        expect(await navigate(view, "/app/t1/posts/2")).toBe("Committed /app/t1/posts/2");
        await shows(view, "2");
        await typeDraft(view, "keep");
        const before = await kept(view);
        expect(before).toMatchObject({ focused: "draft", draft: "keep", caret: [1, 3] });

        // Held: the check is asked before commit. The URL and the entry wait.
        await setMode(view, "held");
        await read(view, "(history.back(), true)");
        await H.waitFor(view, "window.__leave.held === 1", "the held question");
        expect(await kept(view)).toEqual(before);
        expect((await asked(view)).at(-1)).toBe("2?read->1?read:pop");
        await read(view, `(window.__leave.answer("Stay"), true)`);
        await H.waitFor(view, "window.__leave.held === 0", "the answer");
        await settleMargin();
        expect(await kept(view)).toEqual(before);

        // Leave: one commit, one entry back.
        await setMode(view, "leave");
        await read(view, "(history.back(), true)");
        await shows(view, "1");
        expect((await kept(view)).index).toBe((before.index ?? 0) - 1);

        // Forward: refused, then permitted.
        await setMode(view, "stay");
        const count = (await asked(view)).length;
        await read(view, "(history.forward(), true)");
        await askedCount(view, count + 1);
        await settleMargin();
        expect(await read<string>(view, "location.pathname")).toBe("/app/t1/posts/1");
        expect((await asked(view)).at(-1)).toBe("1?read->2?read:pop");
        await setMode(view, "leave");
        // Observed in Chrome 153, on a bare page too: after a refused Forward,
        // `history.forward()` fires no `navigate` event; `navigation.forward()` does.
        await read(view, "(navigation.forward(), true)");
        await shows(view, "2");
        expect((await kept(view)).index).toBe(before.index);
        expect(await logs(view)).toEqual([]);
      } finally {
        closePage(view);
      }
    },
    30_000,
  );

  it("without a precommit handler: the canceled event is re-issued once on Leave", async () => {
    const view = await openAt("chrome", "/app/t1/posts/1", "off");
    try {
      expect(await navigate(view, "/app/t1/posts/2")).toBe("Committed /app/t1/posts/2");
      await shows(view, "2");
      await typeDraft(view, "keep");
      const before = await kept(view);
      const entries = await read<number>(view, "navigation.entries().length");

      await setMode(view, "stay");
      await read(view, "(history.back(), true)");
      await askedCount(view, 2);
      await settleMargin();
      expect(await kept(view)).toEqual(before);

      await setMode(view, "leave");
      await read(view, "(history.back(), true)");
      await shows(view, "1");
      await settleMargin();
      // One question for this Back: the re-issued traversal is not asked again.
      expect(await asked(view)).toEqual([
        "1?read->2?read:push",
        "2?read->1?read:pop",
        "2?read->1?read:pop",
      ]);
      expect((await kept(view)).index).toBe((before.index ?? 0) - 1);
      expect(await read<number>(view, "navigation.entries().length")).toBe(entries);
    } finally {
      closePage(view);
    }
  }, 30_000);

  it("a noncancelable browser-UI Back is followed and reported, never stayed", async () => {
    const view = await openAt("chrome", "/app/t1/posts/1");
    try {
      expect(await navigate(view, "/app/t1/posts/2")).toBe("Committed /app/t1/posts/2");
      await shows(view, "2");
      await setMode(view, "stay");

      // No user activation since the last navigation: the platform will commit.
      await H.uiTraverse(view, -1);
      await shows(view, "1");
      expect(await asked(view)).toEqual(["1?read->2?read:push"]);
      const reported = await logs(view);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("route.leave.unprotected");
      expect(reported[0]).toContain("/app/t1/posts/1 kind=pop checks=1 reason=noncancelable");

      // After real input the same UI traversal is cancelable, and protected.
      await view.click("#draft");
      await H.uiTraverse(view, 1);
      await askedCount(view, 2);
      await settleMargin();
      expect(await read<string>(view, "location.pathname")).toBe("/app/t1/posts/1");
      expect((await asked(view)).at(-1)).toBe("1?read->2?read:pop");
    } finally {
      closePage(view);
    }
  }, 30_000);

  it("Back and Forward restore each entry's scroll once the router is done", async () => {
    const view = await openAt("chrome", "/app/t1/posts/1");
    try {
      expect(await read<number>(view, "(scrollTo(0, 1200), scrollY)")).toBe(1200);
      expect(await navigate(view, "/app/t1/posts/2")).toBe("Committed /app/t1/posts/2");
      expect(await read<number>(view, "(scrollTo(0, 300), scrollY)")).toBe(300);
      await read(view, "(history.back(), true)");
      await shows(view, "1");
      await H.waitFor(view, "scrollY === 1200", "post 1's scroll restored");
      await read(view, "(navigation.forward(), true)");
      await shows(view, "2");
      await H.waitFor(view, "scrollY === 300", "post 2's scroll restored");

      // From a short page, the tall destination exists only once the router
      // installed it: restoration must wait for that, or it clamps to the top.
      expect(await navigate(view, "/elsewhere")).toBe("Committed /elsewhere");
      await H.waitFor(view, `document.querySelector("#missing") && scrollY === 0`, "a short page");
      await read(view, "(history.back(), true)");
      await shows(view, "2");
      await H.waitFor(view, "scrollY === 300", "post 2's scroll restored after its shell");
    } finally {
      closePage(view);
    }
  }, 30_000);

  it("a wholly stayed traversal keeps the caret", async () => {
    const view = await openAt("chrome", "/app/t1/posts/1");
    try {
      expect(await navigate(view, "/app/t1/posts/1?tab=b")).toBe("Committed /app/t1/posts/1?tab=b");
      await shows(view, "1", "b");
      await typeDraft(view, "caret");
      await read(view, "(history.back(), true)");
      await shows(view, "1", "read");
      await settleMargin();
      expect(await kept(view)).toMatchObject({
        sameElement: true,
        draft: "caret",
        focused: "draft",
        caret: [1, 3],
      });
    } finally {
      closePage(view);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// WebKit: this host's WebKit has no Navigation API
// ---------------------------------------------------------------------------

describe.skipIf(webkit === undefined)("leave checks in WebKit", () => {
  it("records the engine's capabilities", async () => {
    console.log(`webkit capability: ${JSON.stringify(webkit)}`);
    const view = await openAt("webkit", "/app/t1/posts/1");
    try {
      // The fixture page sees what the probe recorded; the Back proof branches on it.
      expect(await pageCapabilities(view)).toEqual({
        navigation: webkit?.navigation ?? false,
        precommit: webkit?.precommit ?? false,
      });
      // A precommit handler never exists without the Navigation API.
      expect(webkit?.precommit === true && webkit.navigation !== true).toBe(false);
    } finally {
      closePage(view);
    }
  }, 30_000);

  it("Back is stayed where the engine can cancel it, and followed and reported where it cannot", async () => {
    const view = await openAt("webkit", "/app/t1/posts/1");
    try {
      expect(await navigate(view, "/app/t1/posts/2")).toBe("Committed /app/t1/posts/2");
      await shows(view, "2");
      await setMode(view, "stay");
      // Branch on the probed capability before Back, not on what Back did.
      if (webkit?.navigation === true) {
        // A programmatic Back is cancelable where the API exists: Stay holds.
        await read(view, "(history.back(), true)");
        await askedCount(view, 2);
        await settleMargin();
        expect(await read<string>(view, "location.pathname")).toBe("/app/t1/posts/2");
        expect((await asked(view)).at(-1)).toBe("2?read->1?read:pop");
        expect(await logs(view)).toEqual([]);
        return;
      }
      await read(view, "(history.back(), true)");
      await shows(view, "1");
      expect(await asked(view)).toEqual(["1?read->2?read:push"]);
      const reported = await logs(view);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("/app/t1/posts/1 kind=pop checks=1 reason=committed");
    } finally {
      closePage(view);
    }
  }, 30_000);

  it("a wholly stayed traversal keeps the caret", async () => {
    const view = await openAt("webkit", "/app/t1/posts/1");
    try {
      expect(await navigate(view, "/app/t1/posts/1?tab=b")).toBe("Committed /app/t1/posts/1?tab=b");
      await shows(view, "1", "b");
      await typeDraft(view, "caret");
      await read(view, "(history.back(), true)");
      await shows(view, "1", "read");
      await settleMargin();
      expect(await kept(view)).toMatchObject({
        sameElement: true,
        draft: "caret",
        focused: "draft",
        caret: [1, 3],
      });
    } finally {
      closePage(view);
    }
  }, 30_000);
});
