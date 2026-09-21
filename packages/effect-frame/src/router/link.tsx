import type { Source } from "effect-frame/actor";
import { select } from "effect-frame/actor/client";
import type { Child, Node } from "effect-frame/view";
import { Dom, View } from "effect-frame/view";
import { Effect, Option, Predicate, Schema } from "effect";
import type { AnyRoute, ParamsCodec, Route, SearchCodec, SearchUpdater } from "./route.js";
import { readSearch } from "./route.js";
import type { RouterService } from "./router.js";
import { Router } from "./router.js";

/**
 * A typed link to a route: a live printed href, whether the route is the
 * current one, and the two moves. Yielded in a view's setup, where the
 * `Router` is in context; a `Link` node draws it, or a view uses the parts.
 * A link to a route cannot print a URL the route does not parse, because
 * `href` encodes through the route's own Schemas.
 */
export interface Link {
  readonly href: Source<string>;
  /** `true` while the document is on this link's route, at any values. */
  readonly active: Source<boolean>;
  readonly go: Effect.Effect<void>;
  readonly replace: Effect.Effect<void>;
}

/** A fixed decoded search or a typed update evaluated against the URL. */
export type LinkSearch<Search> = Search | SearchUpdater<Search>;

export const link = <
  Name extends string,
  Params extends ParamsCodec,
  Search extends SearchCodec,
  R,
>(
  route: Route<Name, Params, Search, R>,
  params: Params["Type"],
  search: LinkSearch<Search["Type"]>,
): Effect.Effect<Link, never, Router> =>
  Effect.gen(function* () {
    const router = yield* Router;
    const hrefAt = (url: URL): string => route.hrefAt(url, params, searchAt(route, url, search));
    const href = select(router.current, (match) => hrefAt(match.url));
    return {
      href,
      active: isActive(router, route),
      go: router.navigate(hrefAt),
      replace: router.replace(hrefAt),
    };
  });

const searchAt = <Name extends string, Params extends ParamsCodec, Search extends SearchCodec, R>(
  route: Route<Name, Params, Search, R>,
  url: URL,
  search: LinkSearch<Search["Type"]>,
): Search["Type"] => {
  if (!Predicate.isFunction(search)) {
    return search;
  }
  const decoded = Schema.decodeUnknownOption(route.search)(readSearch(url.searchParams));
  const previous = Option.getOrElse(decoded, () =>
    Option.getOrThrow(Schema.decodeUnknownOption(route.search)({})),
  );
  return search(previous);
};

/** `true` while the document is on `route`, whatever its values. */
export function isActive<R>(router: RouterService, route: AnyRoute<R>): Source<boolean> {
  return select(router.current, (match) => match.name === route.name);
}

export interface LinkProps {
  readonly link: Link;
  /** Replace the history entry instead of pushing one. */
  readonly replace?: boolean;
  readonly class?: string;
  readonly children: Child;
}

/**
 * An anchor drawn from a `Link`: a real `href`, so the platform's own
 * affordances hold (open in a new tab, copy link, middle click), and
 * `aria-current="page"` while the route is the current one. A plain click
 * runs the typed move against the latest URL without a document load.
 */
/** `aria-current="page"` while active; `false` removes the attribute. */
const currentAttribute = (active: boolean): string | false => {
  if (active) {
    return "page";
  }
  return false;
};

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
    aria-current={View.bind(props.link.active, currentAttribute)}
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
