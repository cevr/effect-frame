import { Form, select } from "effect-frame/actor/client";
import type { Source } from "effect-frame/actor/client";
import { Link, link } from "effect-frame/router";
import type { NotFoundProps, Route } from "effect-frame/router";
import { Errored, Loading, View, orErrored, ready } from "effect-frame/view";
import type { Node } from "effect-frame/view";
import { Effect, Option, Predicate } from "effect";
import { snapshotOf, writeMemo } from "./commands.js";
import type { MemoRef } from "./commands.js";
import type { dash } from "./segments.js";
import { orders, overview } from "./segments.js";

/**
 * The shell every dashboard page shares, and the fallbacks. `DashShell`
 * holds the outer `Loading` (#16): the tenant header, the memo, and the
 * page's cards all wait on it, and it sits inside `Errored`, so a failed
 * read shows one fallback and nothing else (#26).
 */

/** What the shell shows while its first reads are in flight. */
export const skeleton: Node = <p id="skeleton">loading</p>;

/** The tag of a failure a query routed to `Errored`. */
const describe = (failure: Option.Option<unknown>): string =>
  Option.match(failure, {
    onNone: () => "",
    onSome: (error) => {
      if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) {
        return `could not load: ${error._tag}`;
      }
      return "could not load";
    },
  });

/** The error fallback. It reads the first failure routed to its scope. */
export const failure = (first: Source<Option.Option<unknown>>): Node => (
  <p id="failure">{View.bind(first, describe)}</p>
);

/**
 * The team memo: the layout's `Memo` actor. A write refreshes no query.
 * The form's own field is the draft: a submit reads it from the event.
 */
const MemoCard = (memo: Source<MemoRef>) =>
  Effect.sync(() => {
    const text = select(snapshotOf(memo), (snapshot) => snapshot.text);
    const save = View.submit((event) =>
      Option.match(
        Option.flatMap(event.form, (fields) => Form.last(fields, "text")),
        {
          onNone: () => Effect.void,
          onSome: (next) => Effect.asVoid(writeMemo(memo, next)),
        },
      ),
    );
    return (
      <section id="memo" class="card">
        <p id="memo-text">{View.bind(text)}</p>
        <form id="memo-form" onSubmit={save}>
          <input id="memo-draft" name="text" />
          <button id="memo-save" type="submit">
            save
          </button>
        </form>
      </section>
    );
  });

/**
 * The tenant's header, its memo, and the page. Everything under the outer
 * `Loading`, so the first frame is either the skeleton or the whole page.
 */
export const DashShell = <ChildR,>(props: Route.LayoutPropsOf<typeof dash, ChildR>) =>
  Errored({
    fallback: failure,
    children: Loading({
      fallback: skeleton,
      children: Effect.gen(function* () {
        const tenant = yield* ready(yield* orErrored(props.data.tenant.state), {
          name: "",
          plan: "",
          alerts: 0,
        });
        const params = yield* props.params.get;
        const home = yield* link(overview, params, {});
        const book = yield* link(orders, params, {});
        const memo = yield* MemoCard(props.data.memo);
        const outlet = yield* props.outlet;
        return (
          <div id="shell">
            <header>
              <h1 id="tenant-name">{View.bind(tenant, (info) => info.name)}</h1>
              <span id="tenant-plan">{View.bind(tenant, (info) => info.plan)}</span>
              <span id="tenant-alerts">{View.bind(tenant, (info) => info.alerts)}</span>
              <nav>
                <Link link={home}>overview</Link> <Link link={book}>orders</Link>
              </nav>
            </header>
            {memo}
            <main id="outlet">{outlet}</main>
          </div>
        );
      }),
    }),
  });

export const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">no such page</p>);
