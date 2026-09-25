import type { Source, QueryFailure } from "effect-frame/actor/client";
import { Link, link } from "effect-frame/router";
import type { NotFoundProps, Route } from "effect-frame/router";
import { View } from "effect-frame/view";
import type { Node } from "effect-frame/view";
import { Effect, Option } from "effect";
import type { chrome } from "./segments.js";
import { index, post } from "./segments.js";

/**
 * The chrome every page shares and the index of posts. No view here knows
 * whether it draws at build, per request, or in the browser.
 */

/** What the chrome shows while its outlet waits for a read. A built page never shows it. */
export const skeleton: Node = <p id="skeleton">loading</p>;

const describe = (failure: Option.Option<QueryFailure>): string =>
  Option.match(failure, {
    onNone: () => "",
    onSome: (error) => `could not load: ${error._tag}`,
  });

const failure = (first: Source<Option.Option<QueryFailure>>): Node => (
  <p id="failure">{View.bind(first, describe)}</p>
);

/** The blog's chrome: a header that links to the index, around one page. */
export const Chrome = <ChildR,>(props: Route.LayoutPropsOf<typeof chrome, ChildR>) =>
  Effect.gen(function* () {
    const home = yield* link(index, {}, {});
    const body = yield* View.errored({
      fallback: failure,
      content: View.loading({ fallback: skeleton, content: props.outlet }),
    });
    return (
      <div id="chrome">
        <header>
          <Link link={home}>posts</Link>
        </header>
        <main id="outlet">{body}</main>
      </div>
    );
  });

/** Every post, newest first, each a link printed by the post route's own `href`. */
export const IndexView = (props: Route.PropsOf<typeof index>) =>
  Effect.gen(function* () {
    const posts = yield* View.ready(props.data.posts.state, []);
    const rows = yield* View.list({
      each: posts,
      keyBy: (summary) => summary.slug,
      row: (summary) =>
        Effect.gen(function* () {
          const current = yield* summary.get;
          const to = yield* link(post, { slug: current.slug }, {});
          return (
            <li>
              <Link link={to}>{View.bind(summary, (value) => value.title)}</Link>{" "}
              <time>{View.bind(summary, (value) => value.date)}</time>
            </li>
          );
        }),
    });
    return (
      <section id="index">
        <h1>Posts</h1>
        <ul id="posts">{rows}</ul>
      </section>
    );
  });

export const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">no such page</p>);
