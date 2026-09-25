import { Source } from "effect-frame/actor/client";
import type { Child, Node } from "effect-frame/view";
import { Dom, View } from "effect-frame/view";
import { Effect, Option, Predicate } from "effect";
import type { AnyRoute, Current, Linkable, SearchUpdater } from "./codec.js";
import type { RouterService } from "./router.js";
import { Router } from "./router.js";

/**
 * A typed link to a route or a nested segment: a live printed href, whether
 * the document is on it, and the two moves. Yielded in a view's setup, where
 * the `Router` is in context; a `Link` node draws it, or a view uses the
 * parts. A link cannot print a URL its destination does not parse, because
 * `href` encodes through the destination's own Schemas.
 */
export interface Link {
  readonly href: Source<string>;
  /** Where the document is relative to the destination. See `Route.Current`. */
  readonly current: Source<Current>;
  /** `true` while `current` is `"page"` or `"ancestor"`. */
  readonly active: Source<boolean>;
  readonly go: Effect.Effect<void>;
  readonly replace: Effect.Effect<void>;
}

/** A fixed decoded search or a typed update evaluated against the URL. */
export type LinkSearch<Search> = Search | SearchUpdater<Search>;

/**
 * A segment is the page while a tree that holds it matched and the URL ends
 * at it, and an ancestor while the URL continues below it. Not-found and
 * another route are neither.
 */
export const link = <Params, Search>(
  to: Linkable<Params, Search>,
  params: NoInfer<Params>,
  search: LinkSearch<NoInfer<Search>>,
): Effect.Effect<Link, never, Router> =>
  Effect.gen(function* () {
    const router = yield* Router;
    const hrefAt = (url: URL): string => to.hrefAt(url, params, searchAt(to, url, search));
    const href = Source.select(router.current, (match) => hrefAt(match.url));
    const current = Source.select(router.current, (match) => to.currentAt(match));
    return {
      href,
      current,
      active: Source.select(current, (where) => where !== "none"),
      go: router.navigate(hrefAt),
      replace: router.replace(hrefAt),
    };
  });

const searchAt = <Params, Search>(
  to: Linkable<Params, Search>,
  url: URL,
  search: LinkSearch<Search>,
): Search => {
  if (!isUpdater(search)) {
    return search;
  }
  return search(to.searchAt(url));
};

function isUpdater<Search>(search: LinkSearch<Search>): search is SearchUpdater<Search> {
  return Predicate.isFunction(search);
}

/** `true` while the document is on `route`, whatever its values. */
export function isActive<R>(router: RouterService, route: AnyRoute<R>): Source<boolean> {
  return Source.select(router.current, (match) => match.name === route.name);
}

export interface LinkProps {
  readonly link: Link;
  /** Replace the history entry instead of pushing one. */
  readonly replace?: boolean;
  readonly class?: string;
  readonly children: Child;
}

/** `false` removes the attribute. */
const currentAttribute = (where: Current): string | false => {
  if (where === "page") {
    return "page";
  }
  if (where === "ancestor") {
    return "true";
  }
  return false;
};

/**
 * An anchor drawn from a `Link`: a real `href`, so the platform's own
 * affordances hold (open in a new tab, copy link, middle click),
 * `aria-current="page"` on the destination, and `aria-current="true"` on an
 * ancestor segment of it. A plain click
 * runs the typed move against the latest URL without a document load.
 */
export const Link = (props: LinkProps): Node => (
  <a
    attach={Dom.attach((element) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const scope = yield* Effect.scope;
        const onClick = (event: Event): void => {
          if (!(event instanceof MouseEvent)) {
            return;
          }
          if (!isPlainClick(event)) {
            return;
          }
          event.preventDefault();
          const move = (): Effect.Effect<void> => {
            if (props.replace === true) {
              return props.link.replace;
            }
            return props.link.go;
          };
          Effect.runForkWith(context)(Effect.forkIn(move(), scope));
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            element.addEventListener("click", onClick);
          }),
          () =>
            Effect.sync(() => {
              element.removeEventListener("click", onClick);
            }),
        );
      }),
    )}
    href={View.bind(props.link.href)}
    class={Option.getOrElse(Option.fromNullishOr(props.class), () => false)}
    aria-current={View.bind(props.link.current, currentAttribute)}
    data-frame-replace={props.replace === true}
  >
    {props.children}
  </a>
);

const isPlainClick = (event: MouseEvent): boolean =>
  event.button === 0 &&
  !event.defaultPrevented &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
