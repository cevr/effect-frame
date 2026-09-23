/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noThrowStatement, effect/noNewError, effect/noTryCatch, no-await-in-loop -- this proof drives real WebKit and Chrome pages through Bun.WebView. */
/**
 * #31 navigation behavior, real-browser proofs. The fixture page mounts the
 * real router on the public `browserNavigation` Location with the public
 * `followLinks`. Scroll and focus are platform facts: no fake window proves
 * them. See `docs/design/navigation-behavior.md`.
 */
import { describe, expect, it } from "bun:test";
import type { NavConfig } from "./browser/navigation-app.js";
import * as H from "./browser/harness.js";

const engines: ReadonlyArray<H.Engine> = ["chrome", "webkit"];
const capabilities = {
  chrome: await H.capabilities("chrome"),
  webkit: await H.capabilities("webkit"),
};

let bundled: Promise<string> | undefined;
const bundleOnce = (): Promise<string> => {
  bundled ??= H.bundle("navigation-app.tsx");
  return bundled;
};

const servers = new WeakMap<Bun.WebView, H.PageServer<NavConfig>>();

const openAt = async (
  engine: H.Engine,
  path: string,
  api: NavConfig["api"] = "native",
  more: Omit<NavConfig, "api"> = {},
): Promise<Bun.WebView> => {
  const server = await H.serve<NavConfig>(await bundleOnce(), { api, ...more }, "__navConfig");
  const view = await H.open(engine, `${server.origin}${path}`);
  servers.set(view, server);
  await H.waitFor(view, "window.__nav && window.__nav.ready", "the router mounted");
  return view;
};

const closePage = (view: Bun.WebView): void => {
  view.close();
  servers.get(view)?.stop();
};

const read = <A>(view: Bun.WebView, expression: string): Promise<A> => view.evaluate<A>(expression);

const navigate = (view: Bun.WebView, href: string) =>
  read<string>(view, `window.__nav.navigate(${JSON.stringify(href)})`);

const shown = (view: Bun.WebView, selector: string) =>
  H.waitFor(view, `document.querySelector(${JSON.stringify(selector)})`, `${selector} shown`);

const scrollTo = (view: Bun.WebView, y: number) =>
  read<number>(view, `(scrollTo(0, ${String(y)}), scrollY)`);

const scrollY = (view: Bun.WebView) => read<number>(view, "scrollY");

const focused = (view: Bun.WebView) =>
  read<string>(view, "document.activeElement ? document.activeElement.id : ''");

/** A Preserve, a stayed segment, and a refused form leave nothing to wait for. */
const settleMargin = () => Bun.sleep(150);

const setups = (view: Bun.WebView) => read<Record<string, number>>(view, "window.__nav.setups");

const tabShown = (view: Bun.WebView, tab: string) =>
  H.waitFor(
    view,
    `document.querySelector("#tab")?.textContent === ${JSON.stringify(tab)}`,
    `tab ${tab}`,
  );

/**
 * Back and Forward between `Preserve` entries put back each entry's saved
 * position, stayed or entering, as a pop does with no router. EGW search
 * found the stayed case: scroll 430, push a new search, scroll 0, Back.
 */
const preserveTraversals = async (engine: H.Engine, api: NavConfig["api"]) => {
  const view = await openAt(engine, "/site/tabs/a", api);
  try {
    await view.click("#search");
    expect(await scrollTo(view, 430)).toBe(430);
    expect(await navigate(view, "/site/tabs/b")).toBe("Committed /site/tabs/b");
    await tabShown(view, "b");
    await settleMargin();
    // A push under Preserve does not move.
    expect(await scrollY(view)).toBe(430);
    expect(await scrollTo(view, 0)).toBe(0);

    await read(view, "(history.back(), true)");
    await tabShown(view, "a");
    await H.waitFor(view, "scrollY === 430", "tab a's position restored");
    expect(await focused(view)).toBe("search");
    expect(await scrollTo(view, 900)).toBe(900);

    await read(view, "(history.forward(), true)");
    await tabShown(view, "b");
    await H.waitFor(view, "scrollY === 0", "tab b's position restored");

    // Enter another leaf, then come back to the Preserve leaf.
    expect(await scrollTo(view, 1500)).toBe(1500);
    expect(await navigate(view, "/site/pages/2")).toBe("Committed /site/pages/2");
    await H.waitFor(view, `document.querySelector("#page-id")?.textContent === "2"`, "page 2");
    await H.waitFor(view, "scrollY === 0", "page 2 at the top");
    await view.click("#search");
    await read(view, "(history.back(), true)");
    await tabShown(view, "b");
    await H.waitFor(view, "scrollY === 1500", "tab b's position restored on entering");
    // Preserve moves no focus, on a traversal too.
    expect(await focused(view)).toBe("search");
  } finally {
    closePage(view);
  }
};

for (const engine of engines) {
  const capability = capabilities[engine];
  describe.skipIf(capability?.navigation !== true)(`navigation behavior in ${engine}`, () => {
    it("a push scrolls to the top when the shell commits, while the query is still open", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");
        expect(await scrollTo(view, 2000)).toBe(2000);
        expect(await navigate(view, "/site/slow")).toBe("Committed /site/slow");
        await shown(view, "#slow-fallback");
        await H.waitFor(view, "scrollY === 0", "the top");
        // The fallback is on screen: the query never settled.
        expect(await read<boolean>(view, `document.querySelector("#slow-value") === null`)).toBe(
          true,
        );
        expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("a push to a URL with a fragment scrolls to the fragment, not to the top", async () => {
      const view = await openAt(engine, "/site/slow");
      try {
        expect(await navigate(view, "/site/pages/1#usage")).toBe("Committed /site/pages/1#usage");
        await shown(view, "#usage");
        await H.waitFor(
          view,
          `(() => { const top = document.querySelector("#usage").getBoundingClientRect().top; return scrollY > 0 && top > -2 && top < innerHeight; })()`,
          "#usage in view",
        );
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("Back restores the browser's saved position", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        expect(await scrollTo(view, 2500)).toBe(2500);
        expect(await navigate(view, "/site/pages/2")).toBe("Committed /site/pages/2");
        await H.waitFor(view, `document.querySelector("#page-id").textContent === "2"`, "page 2");
        await H.waitFor(view, "scrollY === 0", "page 2 at the top");
        await read(view, "(history.back(), true)");
        await H.waitFor(view, `document.querySelector("#page-id").textContent === "1"`, "page 1");
        await H.waitFor(view, "scrollY === 2500", "page 1's position restored");
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("Back waits for the declared read the page's height needs, then restores its position", async () => {
      const view = await openAt(engine, "/site/rows/a");
      try {
        await shown(view, "#rows-content");
        expect(await scrollTo(view, 2500)).toBe(2500);
        expect(await navigate(view, "/site/pages/2")).toBe("Committed /site/pages/2");
        await H.waitFor(view, `document.querySelector("#page-id")?.textContent === "2"`, "page 2");
        await H.waitFor(view, "scrollY === 0", "page 2 at the top");
        // The rows leaf exited, so its key was released: Back reads it again,
        // and that read is held. The shell draws the fallback, a short page.
        await read(view, "(window.__nav.holdRows(), true)");
        await read(view, "(history.back(), true)");
        await shown(view, "#rows-fallback");
        await settleMargin();
        await read(view, "(window.__nav.releaseRows(), true)");
        await shown(view, "#rows-content");
        await H.waitFor(view, "scrollY === 2500", "the rows page's position restored");
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("Back whose declared read never settles lands at the limit, releases the traversal, and never moves later", async () => {
      const view = await openAt(engine, "/site/rows/a", "native", {
        traversalReadLimitMillis: 400,
      });
      try {
        await shown(view, "#rows-content");
        expect(await scrollTo(view, 2500)).toBe(2500);
        expect(await navigate(view, "/site/pages/2")).toBe("Committed /site/pages/2");
        await H.waitFor(view, `document.querySelector("#page-id")?.textContent === "2"`, "page 2");
        await H.waitFor(view, "scrollY === 0", "page 2 at the top");
        // Back reads the released rows key again, and that read is held.
        await read(view, "(window.__nav.holdRows(), true)");
        await read(view, "(history.back(), true)");
        await shown(view, "#rows-fallback");
        // Before the limit the traversal is still held.
        expect(await read<boolean>(view, "navigation.transition !== null")).toBe(true);
        // At the limit it lands on the short page as it is, and the handler is released.
        await H.waitFor(view, "navigation.transition === null", "the traversal released", 3_000);
        const landed = await scrollY(view);
        expect(landed).toBeLessThan(2500);
        expect(await read<boolean>(view, `!!document.querySelector("#rows-fallback")`)).toBe(true);
        // The read settles later: the page grows, and the scroll is not placed again.
        await read(view, "(window.__nav.releaseRows(), true)");
        await shown(view, "#rows-content");
        await settleMargin();
        expect(await scrollY(view)).toBe(landed);
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("history.scrollRestoration stays auto after mount and after ten navigations", async () => {
      const view = await openAt(engine, "/site/pages/0");
      try {
        expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");
        for (let index = 1; index <= 10; index += 1) {
          expect(await navigate(view, `/site/pages/${String(index)}`)).toBe(
            `Committed /site/pages/${String(index)}`,
          );
        }
        expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("a late settle fills content in place and does not move the viewport", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        expect(await navigate(view, "/site/late")).toBe("Committed /site/late");
        await shown(view, "#late-fallback");
        // The push lands after `Committed`: it scrolls to the top, then focuses
        // the leaf root. Scroll only once it has, or landing undoes the scroll.
        await H.waitFor(view, `document.activeElement?.id === "late"`, "the push landed");
        expect(await scrollTo(view, 1000)).toBe(1000);
        await read(view, "window.__nav.settle()");
        await shown(view, "#late-content");
        expect(await read<boolean>(view, `document.querySelector("#late-fallback") === null`)).toBe(
          true,
        );
        expect(await scrollY(view)).toBe(1000);
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("a fragment-only click is left to the browser: no transition, the browser scrolls", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        await read(view, `(window.__marked = document.querySelector("#page"), true)`);
        const before = await setups(view);
        await view.click("#to-usage");
        await H.waitFor(view, `location.hash === "#usage"`, "the fragment");
        await H.waitFor(view, "scrollY > 0", "the browser scrolled");
        // `:target` holds only for a browser fragment navigation, never pushState.
        expect(await read<string>(view, `document.querySelector(":target")?.id ?? ""`)).toBe(
          "usage",
        );
        expect(await read<ReadonlyArray<string>>(view, "window.__nav.events")).toEqual([
          "push:true",
        ]);
        await settleMargin();
        expect(await setups(view)).toEqual(before);
        expect(
          await read<boolean>(view, `document.querySelector("#page") === window.__marked`),
        ).toBe(true);
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("focus moves to the entering leaf's root on a push", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        await view.click("#search");
        expect(await focused(view)).toBe("search");
        expect(await navigate(view, "/site/slow")).toBe("Committed /site/slow");
        await H.waitFor(view, `document.activeElement?.id === "slow"`, "focus on the leaf root");
        expect(await read<string>(view, `document.activeElement.getAttribute("tabindex")`)).toBe(
          "-1",
        );
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("a leaf's own autofocus element wins over the leaf root", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        // Focus is already on the page, so the browser's own autofocus does
        // not act: only the router can move it to the heading.
        await view.click("#search");
        expect(await navigate(view, "/site/titled")).toBe("Committed /site/titled");
        await H.waitFor(
          view,
          `document.activeElement?.id === "titled-heading"`,
          "focus on the heading",
        );
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("a stayed segment keeps focus and the caret across a search or param change", async () => {
      const view = await openAt(engine, "/site/pages/1?q=a");
      try {
        await read(view, `(window.__marked = document.querySelector("#page"), true)`);
        await view.click("#search");
        await view.type("abc");
        await read(view, `(document.querySelector("#search").setSelectionRange(1, 2), true)`);
        const caret = `[document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]`;
        expect(await read<ReadonlyArray<unknown>>(view, caret)).toEqual(["search", 1, 2]);

        expect(await navigate(view, "/site/pages/1?q=b")).toBe("Committed /site/pages/1?q=b");
        await H.waitFor(view, `document.querySelector("#page-q").textContent === "b"`, "q=b");
        await settleMargin();
        expect(await read<ReadonlyArray<unknown>>(view, caret)).toEqual(["search", 1, 2]);

        expect(await navigate(view, "/site/pages/2?q=b")).toBe("Committed /site/pages/2?q=b");
        await H.waitFor(view, `document.querySelector("#page-id").textContent === "2"`, "page 2");
        await settleMargin();
        expect(await read<ReadonlyArray<unknown>>(view, caret)).toEqual(["search", 1, 2]);
        // The leaf stayed: the same element, one setup.
        expect(
          await read<boolean>(view, `document.querySelector("#page") === window.__marked`),
        ).toBe(true);
        expect((await setups(view))["page"]).toBe(1);
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("a form's failed validation keeps focus in the field", async () => {
      const view = await openAt(engine, "/site/form");
      try {
        await view.click("#field");
        await view.type("x");
        const events = (await read<ReadonlyArray<string>>(view, "window.__nav.events")).length;
        await view.press("Enter");
        await H.waitFor(
          view,
          `document.querySelector("#error").textContent === "title is required"`,
          "the refusal",
        );
        await settleMargin();
        expect(await read<ReadonlyArray<string>>(view, "window.__nav.events")).toHaveLength(events);
        expect(await focused(view)).toBe("field");
        expect(await read<string>(view, "location.pathname")).toBe("/site/form");
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("the router adds no aria-live region", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        const live = `document.querySelectorAll("[aria-live]").length`;
        expect(await read<number>(view, live)).toBe(0);
        expect(await navigate(view, "/site/titled")).toBe("Committed /site/titled");
        expect(await navigate(view, "/site/pages/2")).toBe("Committed /site/pages/2");
        await read(view, "(history.back(), true)");
        await shown(view, "#titled");
        expect(await read<number>(view, live)).toBe(0);
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("Preserve leaves scroll and focus alone, entering and stayed", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        await view.click("#search");
        expect(await scrollTo(view, 1500)).toBe(1500);
        expect(await navigate(view, "/site/tabs/a")).toBe("Committed /site/tabs/a");
        await shown(view, "#tabs");
        await settleMargin();
        expect(await scrollY(view)).toBe(1500);
        expect(await focused(view)).toBe("search");

        expect(await scrollTo(view, 2500)).toBe(2500);
        expect(await navigate(view, "/site/tabs/b")).toBe("Committed /site/tabs/b");
        await H.waitFor(view, `document.querySelector("#tab").textContent === "b"`, "tab b");
        await settleMargin();
        expect(await scrollY(view)).toBe(2500);
        expect(await focused(view)).toBe("search");
      } finally {
        closePage(view);
      }
    }, 30_000);
    it("Back and Forward to a Preserve entry restore its saved position", async () => {
      await preserveTraversals(engine, "native");
    }, 30_000);

    it("an initial redirect's replace finishes once the page is shown", async () => {
      const view = await openAt(engine, "/site/old");
      try {
        await shown(view, "#page");
        expect(await read<string>(view, "location.pathname")).toBe("/site/pages/1");
        // The router's replace was intercepted; nothing may keep it waiting.
        await H.waitFor(view, "navigation.transition === null", "no transition left open");
        expect(await read<ReadonlyArray<string>>(view, "window.__nav.events")).toContain(
          "replace:false",
        );
      } finally {
        closePage(view);
      }
    }, 30_000);

    it("each write lands only on its own event: a newer push is not released early", async () => {
      const view = await openAt(engine, "/site/pages/1");
      try {
        // Both are admitted at once: the first draws at once, the second is held.
        expect(
          await read<ReadonlyArray<string>>(
            view,
            `Promise.all([window.__nav.navigate("/site/pages/2"), window.__nav.navigate("/site/held/b")])`,
          ),
        ).toEqual(["Committed /site/pages/2", "Committed /site/held/b"]);
        await H.waitFor(view, `window.__nav.setups["gated:b"] === 1`, "b is building");
        await settleMargin();
        // b's shell has not drawn: its own transition is still open.
        expect(await read<boolean>(view, "navigation.transition !== null")).toBe(true);
        await read(view, `window.__nav.open("b")`);
        await shown(view, "#gated-b");
        await H.waitFor(
          view,
          `navigation.transition === null && document.activeElement?.id === "gated-b"`,
          "b landed on its own event",
        );
        expect(await read<string>(view, "location.pathname")).toBe("/site/held/b");
      } finally {
        closePage(view);
      }
    }, 30_000);
  });

  describe.skipIf(capability === undefined)(
    `navigation behavior in ${engine} without the Navigation API`,
    () => {
      it("a push scrolls to the top and focuses the leaf root with preventScroll", async () => {
        const view = await openAt(engine, "/site/pages/1", "none");
        try {
          expect(await read<boolean>(view, `"navigation" in window`)).toBe(false);
          await read(
            view,
            `(() => {
            window.__focusCalls = [];
            const focus = HTMLElement.prototype.focus;
            HTMLElement.prototype.focus = function (options) {
              window.__focusCalls.push([this.id, options?.preventScroll === true]);
              return focus.call(this, options);
            };
            return true;
          })()`,
          );
          expect(await scrollTo(view, 2000)).toBe(2000);
          expect(await navigate(view, "/site/slow")).toBe("Committed /site/slow");
          await shown(view, "#slow-fallback");
          await H.waitFor(view, `scrollY === 0 && document.activeElement?.id === "slow"`, "landed");
          expect(await read<ReadonlyArray<unknown>>(view, "window.__focusCalls")).toEqual([
            ["slow", true],
          ]);
          expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");

          // A fragment push scrolls to the fragment's element.
          expect(await navigate(view, "/site/pages/1#usage")).toBe("Committed /site/pages/1#usage");
          await shown(view, "#usage");
          await H.waitFor(view, `scrollY > 0 && document.activeElement?.id === "page"`, "landed");
        } finally {
          closePage(view);
        }
      }, 30_000);

      it("Back and Forward to a Preserve entry restore its saved position", async () => {
        await preserveTraversals(engine, "none");
      }, 30_000);

      it("a fragment push finds the raw id, then the decoded id, then a named anchor", async () => {
        const view = await openAt(engine, "/site/pages/1", "none");
        const inView = (expression: string) =>
          `(() => { const found = ${expression}; if (!found) return false; const top = found.getBoundingClientRect().top; return scrollY > 0 && top > -2 && top < innerHeight; })()`;
        try {
          expect(await navigate(view, "/site/pages/2#part%20one")).toBe(
            "Committed /site/pages/2#part%20one",
          );
          await H.waitFor(view, inView(`document.getElementById("part%20one")`), "the raw id");
          expect(await navigate(view, "/site/pages/3#part%20two")).toBe(
            "Committed /site/pages/3#part%20two",
          );
          await H.waitFor(view, inView(`document.getElementById("part two")`), "the decoded id");
          expect(await navigate(view, "/site/pages/4#legacy")).toBe(
            "Committed /site/pages/4#legacy",
          );
          await H.waitFor(
            view,
            inView(`document.getElementsByName("legacy")[0]`),
            "the named anchor",
          );
        } finally {
          closePage(view);
        }
      }, 30_000);
    },
  );
}
