import { Effect, Option, Queue, Result, Stream } from "effect";
import type { Landing, Surface, WriteKind, Written } from "./landing.js";
import { registerSurface } from "./landing.js";
import type { LocationService, RouterService } from "./router.js";

/**
 * The browser side of the router: the History API `Location`, the delegated
 * link listener, and where a landing puts the viewport and focus (#31). A
 * browser entry reaches this module; a server render never calls it, and a
 * memory `Location` has no surface. See `docs/design/navigation-behavior.md`.
 *
 * The router never writes `history.scrollRestoration`: the browser keeps
 * `"auto"` and restores each entry's position itself.
 */

const restores = (landing: Landing): boolean => landing.behavior._tag === "Restore";

/**
 * The element focus moves to: the first `autofocus` element inside the
 * entering leaf's root, or else the root. Nothing when the root is not an
 * element in the document.
 */
const focusTarget = (root: HTMLElement): Option.Option<HTMLElement> => {
  if (!root.isConnected) {
    return Option.none();
  }
  const own = root.querySelector("[autofocus]");
  if (own instanceof HTMLElement) {
    return Option.some(own);
  }
  return Option.some(root);
};

/**
 * Move focus to the entering leaf. `preventScroll`: the scroll rule already
 * placed the viewport, and a focus call must not move it again.
 */
const placeFocus = (landing: Landing): void => {
  const element = Option.filter(
    landing.focus,
    (root): root is HTMLElement => root instanceof HTMLElement,
  );
  Option.map(Option.flatMap(element, focusTarget), (target) => {
    target.focus({ preventScroll: true });
  });
};

/** Where a fragment points: an element, the top of the document, or nothing. */
type Indicated =
  | { readonly _tag: "Element"; readonly element: Element }
  | { readonly _tag: "Top" }
  | { readonly _tag: "None" };

const top: Indicated = { _tag: "Top" };
const indicatedNone: Indicated = { _tag: "None" };

/** The HTML "potential indicated element": an `id`, then an `<a name>`. */
const potential = (fragment: string): Option.Option<Element> =>
  Option.orElse(Option.fromNullishOr(document.getElementById(fragment)), () =>
    Option.fromNullishOr(
      Array.from(document.getElementsByTagName("a")).find(
        (anchor) => anchor.getAttribute("name") === fragment,
      ),
    ),
  );

const isHex = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x46) ||
  (byte >= 0x61 && byte <= 0x66);

/** The URL standard's percent-decode, then UTF-8 decode without BOM or fail. */
const percentDecoded = (input: string): Option.Option<string> => {
  const bytes = new TextEncoder().encode(input);
  const out: Array<number> = [];
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    const high = bytes[index + 1] ?? 0;
    const low = bytes[index + 2] ?? 0;
    if (byte === 0x25 && index + 2 < bytes.length && isHex(high) && isHex(low)) {
      out.push(Number.parseInt(String.fromCharCode(high, low), 16));
      index += 3;
    } else {
      out.push(byte);
      index += 1;
    }
  }
  return Option.getSuccess(
    Result.try(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(out)),
    ),
  );
};

/**
 * The HTML "indicated part" of the current URL's fragment: the raw
 * fragment's element, then the decoded fragment's element, then `top`
 * (any case) as the top of the document. An empty fragment is the top.
 */
const indicated = (): Indicated => {
  const fragment = window.location.hash.slice(1);
  if (fragment === "") {
    return top;
  }
  const raw = potential(fragment);
  if (Option.isSome(raw)) {
    return { _tag: "Element", element: raw.value };
  }
  const decoded = percentDecoded(fragment);
  const found = Option.flatMap(decoded, potential);
  if (Option.isSome(found)) {
    return { _tag: "Element", element: found.value };
  }
  if (Option.exists(decoded, (text) => text.toLowerCase() === "top")) {
    return top;
  }
  return indicatedNone;
};

/**
 * Without the Navigation API, the platform's push default by hand: the
 * fragment's indicated part, or the top of the document when there is none.
 */
const scrollToLocation = (): void => {
  const part = indicated();
  if (part._tag === "Element") {
    part.element.scrollIntoView();
    return;
  }
  window.scrollTo(0, 0);
};

/** The History API's write, with no interception. */
const historyWrite = (kind: WriteKind, url: URL): void => {
  if (kind === "push") {
    window.history.pushState({}, "", url.href);
    return;
  }
  window.history.replaceState({}, "", url.href);
};

/** Place a History API write: scroll to the fragment or the top, then focus. */
const placeWritten = (landing: Option.Option<Landing>): Effect.Effect<void> =>
  Effect.sync(() => {
    Option.map(Option.filter(landing, restores), (placed) => {
      scrollToLocation();
      placeFocus(placed);
    });
  });

/** A History API write's handle. Nothing waits on it: landing only places. */
export const historyWritten: Written = { land: placeWritten };

/**
 * The History API surface. A write scrolls to the fragment or the top, then
 * focuses. A followed pop only focuses: the browser already restored the
 * entry's position at `popstate`, early and by its own record.
 */
export const historySurface: Surface = {
  write: (kind, url) =>
    Effect.sync(() => {
      historyWrite(kind, url);
      return historyWritten;
    }),
  pop: (landing) =>
    Effect.sync(() => {
      Option.map(Option.filter(landing, restores), placeFocus);
    }),
};

/**
 * The document's own location and history, through the History API. For the
 * Navigation API, and for leave checks on Back and Forward, use
 * `browserNavigation`, which falls back to this where the API is absent.
 */
export const browserLocation: LocationService = /* @__PURE__ */ registerSurface(
  {
    current: /* @__PURE__ */ Effect.sync(() => new URL(window.location.href)),
    push: (url) =>
      Effect.sync(() => {
        historyWrite("push", url);
      }),
    replace: (url) =>
      Effect.sync(() => {
        historyWrite("replace", url);
      }),
    // Suspended so that importing the module needs no window.
    pops: /* @__PURE__ */ Stream.suspend(() =>
      Stream.map(Stream.fromEventListener(window, "popstate"), () => new URL(window.location.href)),
    ),
  },
  historySurface,
);

/**
 * Only the fragment differs from the document's URL: a same-document
 * fragment navigation, which the browser performs itself (it scrolls, and
 * `:target` holds). `href="#"` counts: it names the top.
 */
const fragmentOnly = (anchor: HTMLAnchorElement): boolean =>
  anchor.pathname === window.location.pathname &&
  anchor.search === window.location.search &&
  (anchor.hash !== "" || anchor.href.endsWith("#"));

/** The anchor a click landed on, when it is one the router should follow. */
const followable = (event: MouseEvent): Option.Option<HTMLAnchorElement> => {
  if (event.defaultPrevented || event.button !== 0) {
    return Option.none();
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return Option.none();
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return Option.none();
  }
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return Option.none();
  }
  if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
    return Option.none();
  }
  if (anchor.origin !== window.location.origin || fragmentOnly(anchor)) {
    return Option.none();
  }
  return Option.some(anchor);
};

/**
 * One delegated click handler at the root. It intercepts a click only when
 * the browser would have followed a same-origin link in this tab to another
 * document address; a middle click, a modifier, `target="_blank"`, a
 * download, another origin, and a fragment on the current page are all left
 * to the browser. A typed Link attaches its queued action to the anchor;
 * this listener handles ordinary anchors and keeps that same policy.
 *
 * The decision and `preventDefault` happen inside the listener, on the
 * browser's own call: a stream would deliver the event after the browser
 * had already followed the link. Only the navigation itself is queued.
 */
export const followLinks = /* @__PURE__ */ Effect.fn("Router.followLinks")(function* (
  root: EventTarget,
  router: RouterService,
) {
  const hrefs = yield* Queue.unbounded<{ readonly href: string; readonly replace: boolean }>();
  const listener = (event: Event) => {
    if (!(event instanceof MouseEvent)) {
      return;
    }
    Option.match(followable(event), {
      onNone: () => {},
      onSome: (anchor) => {
        event.preventDefault();
        Queue.offerUnsafe(hrefs, {
          href: anchor.href,
          replace: anchor.getAttribute("data-frame-replace") === "true",
        });
      },
    });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      root.addEventListener("click", listener);
    }),
    () =>
      Effect.sync(() => {
        root.removeEventListener("click", listener);
      }),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(Stream.fromQueue(hrefs), (request) => {
      if (request.replace) {
        return router.replace(request.href);
      }
      return router.navigate(request.href);
    }),
  );
});

/**
 * Place the router's own push or replace the Navigation API intercepted:
 * the event's own scroll (top or fragment), then focus. `Preserve` places
 * nothing. A traversal is `placeTraversal`.
 */
export const placeIntercepted = (landing: Landing, event: NavigateEvent): void => {
  if (!restores(landing)) {
    return;
  }
  // `scroll()` throws once the navigation finished or was aborted: then
  // there is no position left to place.
  Result.try(() => event.scroll());
  placeFocus(landing);
};

/**
 * Place a traversal the Navigation API intercepted: the entry's saved
 * position under either behavior, then focus under `Restore`. `Preserve`
 * keeps a push or replace where the page is; a Back or Forward returns to
 * where the entry was, as the platform does for a pop no handler held
 * (`placePop`). So both Locations put the same landing at the same place.
 */
export const placeTraversal = (landing: Landing, event: NavigateEvent): void => {
  // `scroll()` throws once the navigation finished or was aborted.
  Result.try(() => event.scroll());
  if (restores(landing)) {
    placeFocus(landing);
  }
};

/** Place a landing for a pop no handler held: focus only. The browser restored scroll. */
export const placePop = (landing: Landing): void => {
  if (restores(landing)) {
    placeFocus(landing);
  }
};
