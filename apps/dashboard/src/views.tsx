import { Actor, Behavior, Form, Source, Value } from "effect-frame/actor/client";
import type { RemoteCommandRef, QueryFailure } from "effect-frame/actor/client";
import { Link, link } from "effect-frame/router";
import type { NotFoundProps, Route } from "effect-frame/router";
import { View } from "effect-frame/view";
import type { Node } from "effect-frame/view";
import { Effect, Option } from "effect";
import type { Memo } from "./contract.js";
import type { dash } from "./segments.js";
import { ordersIndex, overview } from "./segments.js";

/**
 * The shell every dashboard page shares, and the fallbacks. `DashShell`
 * holds the outer `Loading` (#16): the tenant header, the memo, and the
 * page's cards all wait on it, and it sits inside `Errored`, so a failed
 * read shows one fallback and nothing else (#26).
 */

/** What the shell shows while its first reads are in flight. */
export const skeleton: Node = <p id="skeleton">loading</p>;

/** The tag of a failure a query routed to `Errored`. */
const describe = (failure: Option.Option<QueryFailure>): string =>
  Option.match(failure, {
    onNone: () => "",
    onSome: (error) => `could not load: ${error._tag}`,
  });

/** The error fallback. It reads the first failure routed to its scope. */
export const failure = (first: Source<Option.Option<QueryFailure>>): Node => (
  <p id="failure">{View.bind(first, describe)}</p>
);

/**
 * The team memo. The page only writes it: a send-only reference, so the
 * memo is no live stream (#25 §4). It shows what the host committed for
 * this page's last write, from the settled handle. A write refreshes no
 * query. The form's own field is the draft: a submit reads it from the
 * event.
 */
const MemoCard = (memo: Source<RemoteCommandRef<typeof Memo>>) =>
  Effect.gen(function* () {
    const saved = yield* Actor.local(Behavior.value(""));
    const write = (next: string) =>
      Effect.gen(function* () {
        const current = yield* memo.get;
        const handle = yield* current.send({ _tag: "Write", text: next });
        const settled = yield* handle.settled;
        if (settled._tag === "Applied") {
          yield* saved.send(Value.Set(settled.state.text));
        }
      });
    const save = View.submit((event) =>
      Option.match(
        Option.flatMap(event.form, (fields) => Form.last(fields, "text")),
        {
          onNone: () => Effect.void,
          onSome: write,
        },
      ),
    );
    return (
      <section id="memo" class="card">
        <p id="memo-text">{View.bind(saved.state)}</p>
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
  View.errored({
    fallback: failure,
    content: View.loading({
      fallback: skeleton,
      content: Effect.gen(function* () {
        // Held while stale: an ack's override, or a command's refresh in flight.
        const header = yield* View.readyWithStale(yield* View.orErrored(props.data.tenant.state), {
          name: "",
          plan: "",
          alerts: 0,
        });
        const tenant = Source.select(header, (shown) => shown.value);
        const home = yield* link(overview, props.params, {});
        const book = yield* link(ordersIndex, props.params, {});
        const memo = yield* MemoCard(props.data.memo.ref);
        const outlet = yield* props.outlet;
        return (
          <div id="shell">
            <header>
              <h1 id="tenant-name">{View.bind(tenant, (info) => info.name)}</h1>
              <span id="tenant-plan">{View.bind(tenant, (info) => info.plan)}</span>
              <span
                id="tenant-alerts"
                class={View.bind(header, (shown) => {
                  if (shown.stale) {
                    return "stale";
                  }
                  return "fresh";
                })}
              >
                {View.bind(tenant, (info) => info.alerts)}
              </span>
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
