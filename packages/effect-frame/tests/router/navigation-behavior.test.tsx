/* oxlint-disable effect/noGlobals -- the server-render proof puts a recording `navigation` on globalThis, and the bundle proof reads Bun.build output. */
import { registerDom } from "./dom-setup.js";

registerDom();

import { NavigationBehavior, Route } from "effect-frame/router";
import type { MountOptions, NotFoundProps } from "effect-frame/router";
import { Dom } from "effect-frame/view";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { renderUrl } from "./fixtures/server-entry.js";

/**
 * #31 proofs that need no real browser: the shape of `NavigationBehavior`,
 * what no router module does, and what a server render never reaches. The
 * scroll and focus rows are in `navigation-browser.test.ts`. See
 * `docs/design/navigation-behavior.md`.
 */

const Nothing = Schema.Struct({});
const shell = Route.segment("shell", { path: "/shell", params: Nothing });
const child = Route.child(shell, "child", { path: "child", params: Nothing });
const ChildView = () => Effect.succeed(<article>child</article>);

// A leaf takes a behavior value.
const preserved = Route.leaf(child, ChildView, { landing: NavigationBehavior.Preserve });

Route.layout(
  shell,
  [preserved],
  (props) => Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
  {
    // @ts-expect-error a layout names no landing: the destination leaf does.
    landing: NavigationBehavior.Preserve,
  },
);

// @ts-expect-error behavior is a value, not a boolean flag.
Route.leaf(child, ChildView, { landing: true });

// Each value has its own variant's type, not the union.
const restoreExact: NavigationBehavior.Restore = NavigationBehavior.Restore;
const preserveExact: NavigationBehavior.Preserve = NavigationBehavior.Preserve;

const NotFound = (_props: NotFoundProps) => Effect.succeed(<p>missing</p>);
const withDefault: MountOptions<never, globalThis.Node> = {
  routes: [],
  notFound: NotFound,
  host: Dom.host,
  root: document.createElement("main"),
  landing: NavigationBehavior.Restore,
};
const withFlag: MountOptions<never, globalThis.Node> = {
  ...withDefault,
  // @ts-expect-error the router default is a value too.
  landing: "preserve",
};

/** A scroll position, stored or read, or a store to keep one in. */
const scrollState =
  /\b(sessionStorage|localStorage|scrollRestoration|scrollY|scrollX|pageYOffset|pageXOffset|scrollTop|scrollLeft)\b/;

/** Code without its comments: the rule is about what runs, not what is said. */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");

const routerDirectory = `${import.meta.dir}/../../src/router`;

const routerSources = Effect.flatMap(
  Effect.promise(() => Array.fromAsync(new Bun.Glob("*.{ts,tsx}").scan({ cwd: routerDirectory }))),
  (paths) =>
    Effect.forEach(paths, (path) =>
      Effect.map(
        Effect.promise(() => Bun.file(`${routerDirectory}/${path}`).text()),
        (text) => ({
          path,
          text,
        }),
      ),
    ),
);

describe("navigation behavior", () => {
  it.effect("is a tagged value with two members", () =>
    Effect.sync(() => {
      expect(NavigationBehavior.Restore).toEqual({ _tag: "Restore" });
      expect(NavigationBehavior.Preserve).toEqual({ _tag: "Preserve" });
      expect(preserved._tag).toBe("Branch");
      expect(withFlag.routes).toEqual([]);
      expect([restoreExact._tag, preserveExact._tag]).toEqual(["Restore", "Preserve"]);
    }),
  );

  it.effect("no router module reads or writes a scroll position or a storage", () =>
    Effect.gen(function* () {
      const files = yield* routerSources;
      expect(files.map((file) => file.path)).toContain("navigation.ts");
      expect(files.map((file) => file.path)).toContain("browser-commit.ts");
      const offenders = files
        .filter((file) => scrollState.test(code(file.text)))
        .map((file) => file.path);
      expect(offenders).toEqual([]);
    }),
  );

  it.effect("a server render of a branch installs no navigation listener", () =>
    Effect.gen(function* () {
      const added: Array<string> = [];
      const recording = {
        addEventListener: (type: string) => {
          added.push(type);
        },
        removeEventListener: () => {},
      };
      const before = Reflect.get(globalThis, "navigation");
      Reflect.set(globalThis, "navigation", recording);
      const html = yield* renderUrl("http://site.test/site/pages/7").pipe(
        Effect.ensuring(Effect.sync(() => Reflect.set(globalThis, "navigation", before))),
      );
      expect(added).toEqual([]);
      // The leaf's root is marked for focus, and nothing else is written.
      expect(html).toBe('<main><article tabindex="-1">7</article></main>');
    }),
  );

  it.effect("a server bundle of a routed tree excludes the browser navigation modules", () =>
    Effect.gen(function* () {
      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [`${import.meta.dir}/fixtures/server-entry.tsx`],
          target: "bun",
          format: "esm",
          conditions: ["source"],
          minify: false,
        }),
      );
      expect(built.success).toBe(true);
      const text = yield* Effect.forEach(built.outputs, (output) =>
        Effect.promise(() => output.text()),
      );
      const bundle = text.join("\n");
      // The routed tree is in it.
      expect(bundle).toContain("registerShell");
      // `navigation.ts` and `browser-commit.ts` are not.
      for (const marker of [
        "historySurface",
        "placeIntercepted",
        "browserCommit",
        "browserLocation",
        "followLinks",
        "focusReset",
        "preventScroll",
      ]) {
        expect({ marker, found: bundle.includes(marker) }).toEqual({ marker, found: false });
      }
    }),
  );
});
