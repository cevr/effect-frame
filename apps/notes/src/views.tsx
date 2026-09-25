import { Behavior, select, spawn } from "effect-frame/actor/client";
import type { Source } from "effect-frame/actor/client";
import { Link, link } from "effect-frame/router";
import type { NotFoundProps, Route } from "effect-frame/router";
import { Errored, For, Loading, View, ready } from "effect-frame/view";
import type { Node } from "effect-frame/view";
import { Effect, Option, Predicate } from "effect";
import { writeDraft } from "./commands.js";
import type { ListEntry } from "./queries.js";
import type { lists, shell } from "./segments.js";
import { index, list, scratch } from "./segments.js";

/**
 * The views around a list: the shell every page shares, the lists layout,
 * the index, and the scratch page. Like `ListView`, none of them knows the
 * mode it draws in.
 */

/** What the shell shows while its outlet waits for a query. */
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

/** The chrome every page shares, around what its outlet drew. */
const chrome = (body: Node) =>
  Effect.gen(function* () {
    const home = yield* link(index, {}, {});
    const draft = yield* link(scratch, {}, {});
    return (
      <div id="shell">
        <header>
          <Link link={home}>lists</Link> <Link link={draft}>scratch</Link>
        </header>
        <main id="outlet">{body}</main>
      </div>
    );
  });

/**
 * The shell of a page that reads. Its outlet sits in `Loading` inside
 * `Errored` (#16, #26): one fallback at a time, whichever the outlet needs.
 */
export const Shell = <ChildR,>(props: Route.LayoutPropsOf<typeof shell, ChildR>) =>
  Effect.flatMap(
    Errored({
      fallback: failure,
      children: Loading({ fallback: skeleton, children: props.outlet }),
    }),
    chrome,
  );

/**
 * The shell of a page that reads nothing. A `Loading` that nothing
 * registers with waits for ever (#16), so this one has none.
 */
export const BareShell = <ChildR,>(props: Route.LayoutPropsOf<typeof shell, ChildR>) =>
  Effect.flatMap(props.outlet, chrome);

/** Every list's name, beside whichever list page the outlet holds. */
export const ListsView = <ChildR,>(props: Route.LayoutPropsOf<typeof lists, ChildR>) =>
  Effect.gen(function* () {
    const names = yield* ready(props.data.names.state, []);
    const outlet = yield* props.outlet;
    const rows = yield* View.list({
      each: names,
      keyBy: (entry: ListEntry) => entry.name,
      row: (entry) =>
        Effect.gen(function* () {
          const current = yield* entry.get;
          const to = yield* link(list, { list: current.name }, {});
          return (
            <li>
              <Link link={to}>{current.name}</Link>{" "}
              <span class="size">{View.bind(entry, (value) => value.count)}</span>
            </li>
          );
        }),
    });
    return (
      <div id="lists">
        <ul id="names">{rows}</ul>
        {outlet}
      </div>
    );
  });

/** The list names that match the search box. Typing moves the URL, not the page. */
export const IndexView = (props: Route.PropsOf<typeof index>) =>
  Effect.gen(function* () {
    const found = yield* ready(props.data.found.state, []);
    const q = select(props.search, (search) =>
      Option.getOrElse(Option.fromNullishOr(search.q), () => ""),
    );
    const search = (text: string) =>
      props.replaceSearch(() => {
        if (text === "") {
          return {};
        }
        return { q: text };
      });
    return (
      <section id="index">
        <input
          id="q"
          name="q"
          value={View.bind(q)}
          onInput={View.event((event) => search(event.value))}
        />
        <ul id="found">
          <For each={found} keyBy={(entry) => entry.name}>
            {(entry) => <li>{View.bind(entry, (value) => value.name)}</li>}
          </For>
        </ul>
      </section>
    );
  });

/** A draft that lives in this tab only. The server draws nothing here and reads nothing. */
export const ScratchView = (_props: Route.PropsOf<typeof scratch>) =>
  Effect.gen(function* () {
    const draft = yield* spawn(Behavior.value(""));
    const setDraft = writeDraft(draft);
    return (
      <section id="scratch">
        <textarea id="scratch-text" onInput={View.event((event) => setDraft(event.value))} />
        <p id="scratch-length">{View.bind(draft.state, (text) => text.length)}</p>
      </section>
    );
  });

export const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">no such page</p>);
