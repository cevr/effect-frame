import { Source } from "effect-frame/actor/client";
import type { Child, Node } from "effect-frame/view";
import { Dom, View } from "effect-frame/view";
import { Effect, Option, Predicate, Stream } from "effect";
import type { Current, Linkable, SearchUpdater } from "./codec.js";
import { followable } from "./navigation.js";
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
  /** Move to the destination and push a history entry. */
  readonly push: Effect.Effect<void>;
  /** Move to the destination and replace the current history entry. */
  readonly replace: Effect.Effect<void>;
}

/** A fixed decoded search or a typed update evaluated against the URL. */
export type LinkSearch<Search> = Search | SearchUpdater<Search>;

/**
 * Fixed params, or a `Source` of them the link follows. A view that
 * outlives a param move (a layout while its params change) passes a Source,
 * so its links print and move with the params it holds now.
 */
export type LinkParams<Params> = Params | Source<Params>;

/**
 * A link is the page while a tree that holds its segment matched and the
 * URL's path is the segment's path printed with the link's params, and an
 * ancestor while the URL's path continues below that printed path. The same
 * segment with other params, not-found, and another route are neither. The
 * search never counts: `/lists/inbox?sort=date` is still the `inbox` page,
 * so a link to it is `"page"` whatever search either side carries.
 *
 * ```ts
 * // Fixed params: a list page's link to one list.
 * const inbox = yield* link(list, { list: "inbox" }, {});
 * // A layout's link that follows its own params across a tenant move.
 * const home = yield* link(overview, props.params, {});
 * ```
 */
export const link = <Params, Search>(
  to: Linkable<Params, Search>,
  params: LinkParams<NoInfer<Params>>,
  search: LinkSearch<NoInfer<Search>>,
): Effect.Effect<Link, never, Router> =>
  Effect.gen(function* () {
    const router = yield* Router;
    const held = paramsSource(params);
    const hrefAt =
      (fixed: Params) =>
      (url: URL): string =>
        to.hrefAt(url, fixed, searchAt(to, url, search));
    const href = Source.zipWith(router.current, held, (match, fixed) => hrefAt(fixed)(match.url));
    const current = Source.zipWith(router.current, held, (match, fixed) =>
      to.currentAt(match, fixed),
    );
    return {
      href,
      current,
      active: Source.select(current, (where) => where !== "none"),
      push: Effect.flatMap(held.get, (fixed) => router.push(hrefAt(fixed))),
      replace: Effect.flatMap(held.get, (fixed) => router.replace(hrefAt(fixed))),
    };
  });

const paramsSource = <Params,>(params: LinkParams<Params>): Source<Params> => {
  if (isParamsSource(params)) {
    return params;
  }
  return Source.succeed(params);
};

/** A Source is a `get` Effect and a `changes` Stream; a params record is neither. */
function isParamsSource<Params>(params: LinkParams<Params>): params is Source<Params> {
  return (
    Predicate.hasProperty(params, "get") &&
    Predicate.hasProperty(params, "changes") &&
    Effect.isEffect(params.get) &&
    Stream.isStream(params.changes)
  );
}

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
 * ancestor segment of it. A plain click, under the policy `followLinks`
 * shares (`followable`),
 * runs the typed move against the latest URL without a document load.
 */
export const Link = (props: LinkProps): Node => (
  <a
    attach={Dom.attach((element) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const scope = yield* Effect.scope;
        const onClick = (event: Event): void => {
          if (!(event instanceof MouseEvent) || Option.isNone(followable(event))) {
            return;
          }
          event.preventDefault();
          const move = (): Effect.Effect<void> => {
            if (props.replace === true) {
              return props.link.replace;
            }
            return props.link.push;
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
    class={props.class}
    aria-current={View.bind(props.link.current, currentAttribute)}
  >
    {props.children}
  </a>
);
