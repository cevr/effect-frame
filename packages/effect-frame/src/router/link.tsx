import type { Source } from "effect-frame/actor";
import { select } from "effect-frame/actor/client";
import type { Child, Node } from "effect-frame/view";
import { View } from "effect-frame/view";
import { Effect, Option } from "effect";
import type { AnyRoute, ParamsCodec, Route, SearchCodec } from "./route.js";
import type { NavigateOptions, RouterService } from "./router.js";
import { Router } from "./router.js";

/**
 * A typed link to a route: the printed href, whether the route is the
 * current one, and the move itself. Yielded in a view's setup, where the
 * `Router` is in context; a `Link` node draws it, or a view uses the parts.
 * A link to a route cannot print a URL the route does not parse, because
 * `href` encodes through the route's own Schemas.
 */
export interface Link {
  readonly href: string;
  /** `true` while the document is on this link's route, at any values. */
  readonly active: Source<boolean>;
  readonly go: (options?: NavigateOptions) => Effect.Effect<void>;
}

export const link = <
  Name extends string,
  Params extends ParamsCodec,
  Search extends SearchCodec,
  R,
>(
  route: Route<Name, Params, Search, R>,
  params: Params["Type"],
  search: Search["Type"],
): Effect.Effect<Link, never, Router> =>
  Effect.gen(function* () {
    const router = yield* Router;
    const href = route.href(params, search);
    return {
      href,
      active: isActive(router, route),
      go: (options) => router.navigate(href, options),
    };
  });

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
 * moves through the router without a document load.
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
    href={props.link.href}
    class={Option.getOrElse(Option.fromNullishOr(props.class), () => false)}
    aria-current={View.bind(props.link.active, currentAttribute)}
    onClick={View.submit(() => props.link.go({ replace: props.replace === true }))}
  >
    {props.children}
  </a>
);
