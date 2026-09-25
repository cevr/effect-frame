// #region imports
import type { QueryState, RemoteActorRef } from "effect-frame/actor/client";
import { Source } from "effect-frame/actor/client";
import type { NotFoundProps } from "effect-frame/router";
import { Link, Route, link } from "effect-frame/router";
import { For, Show, View } from "effect-frame/view";
import { Effect, Schema } from "effect";
import { Counter, CounterNames, Increment, Reset, counterBehavior } from "./contract.js";
// #endregion imports

// #region segments
// A segment is an address: a path template, the params it declares, and the
// data its page needs. `data` derives each declaration from the params, and
// the route opens, moves and releases it.
export const shell = Route.segment("shell", {
  path: "/",
  data: () => ({ names: Route.query(CounterNames, {}) }),
});

// A child continues its parent's path and declares only its own params.
export const counter = Route.child(shell, "counter", {
  path: "counters/:name",
  params: Schema.Struct({ name: Schema.String }),
  data: ({ params }) => ({
    counter: Route.actor(Counter, { name: params.name }, { behavior: counterBehavior }),
  }),
});
// #endregion segments

// #region leaf-view
// A view is `(props) => Effect.gen(...)`. It runs once per mounted identity;
// a change moves only what binds the source that changed.
export const CounterView = (props: Route.PropsOf<typeof counter>) =>
  Effect.gen(function* () {
    // `state` follows the actor the route holds now, across param moves.
    const count = props.data.counter.state;
    const big = Source.select(count, (value) => value >= 10);
    // One region per actor: a move to another counter builds its form again.
    const controls = yield* View.keyed(
      props.data.counter.ref,
      (ref) => ref.key.name,
      (ref) => Effect.flatMap(ref.get, (current) => Controls({ counter: current })),
    );
    return (
      <section>
        <h1>{View.bind(props.params, (params) => params.name)}</h1>
        <p>count: {View.bind(count)}</p>
        <Show when={big}>
          <p>that is a lot</p>
        </Show>
        {controls}
      </section>
    );
  });

// A child view is a function the parent yields, never a JSX tag.
const Controls = (props: { readonly counter: RemoteActorRef<typeof Counter> }) =>
  Effect.gen(function* () {
    // The form posts with no script and sends over the transport with one.
    const add = yield* View.form({
      ref: props.counter,
      message: Increment,
      typed: ["by"],
      endpoint: "/actors",
      returnTo: counter.href({ name: props.counter.key.name }, {}),
    });
    const reset = View.event(Effect.asVoid(props.counter.send(Reset.make({}))));
    return (
      <div>
        <form onSubmit={add.submit}>
          <input name="by" value="1" />
          <button type="submit">add</button>
        </form>
        <For each={add.issues} keyBy={(issue) => `${issue.field}:${issue.message}`}>
          {(issue) => <p>{View.bind(issue, (one) => one.message)}</p>}
        </For>
        <button type="button" onClick={reset}>
          reset
        </button>
      </div>
    );
  });
// #endregion leaf-view

// #region layout-view
// A layout wraps its child's view, which it gets as `props.outlet`. It stays
// generic in `ChildR`, what the child's view needs; in a .tsx file the
// generic takes a trailing comma.
export const ShellView = <ChildR,>(props: Route.LayoutPropsOf<typeof shell, ChildR>) =>
  Effect.gen(function* () {
    // `View.loading` shows its fallback until every `View.ready` inside it
    // has a first value. A `View.ready` with no `View.loading` above it
    // does not compile where the tree is mounted.
    const nav = yield* View.loading({
      fallback: <p>loading</p>,
      content: Names({ names: props.data.names.state }),
    });
    const body = yield* View.loading({ fallback: <p>loading</p>, content: props.outlet });
    return (
      <main>
        <nav>{nav}</nav>
        {body}
      </main>
    );
  });

const Names = (props: { readonly names: Source<QueryState<ReadonlyArray<string>, unknown>> }) =>
  Effect.gen(function* () {
    const names = yield* View.ready(props.names, []);
    // A keyed list whose rows run an Effect: here, each row makes its link.
    const rows = yield* View.list({
      each: names,
      keyBy: (name) => name,
      row: (name) =>
        Effect.gen(function* () {
          const current = yield* name.get;
          const to = yield* link(counter, { name: current }, {});
          return (
            <li>
              <Link link={to}>{current}</Link>
            </li>
          );
        }),
    });
    return <ul>{rows}</ul>;
  });
// #endregion layout-view

// #region routes
// A route is a tree of branches mounted by one rendering-mode constructor.
// `Route.ssr` resolves every declared read on the server before it draws.
export const App = Route.ssr(
  "app",
  Route.layout(shell, [Route.leaf(counter, CounterView)], ShellView),
);

// `/` has no page of its own.
export const Home = Route.redirecting("home", Route.segment("home", { path: "/" }), () =>
  Effect.succeed(Route.redirect(counter, { name: "home" }, {})),
);

export const routes = [Home, App];

export const NotFound = (_props: NotFoundProps) => Effect.succeed(<p>no such page</p>);
// #endregion routes
