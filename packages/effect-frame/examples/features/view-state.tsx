import type { RemoteActorRef } from "effect-frame/actor/client";
import { Actor, Behavior, Generated, Source, Value } from "effect-frame/actor/client";
import { Route, UrlState } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";
import type { Notes } from "./forms.js";

// #region local-state
// A view's own state is a local actor. `Behavior.value` holds one value:
// `state` reads it, and `send(Value.Set(next))` writes it. The actor lives
// in the view's scope and stops with it.
export const Draft = (props: { readonly notes: RemoteActorRef<typeof Notes> }) =>
  Effect.gen(function* () {
    const draft = yield* Actor.local(Behavior.value(""));
    const empty = Source.select(draft.state, (text) => text.trim() === "");
    // A message with a generated field is sent without it: `Generated.send`
    // mints `id` from the command's own id, so a retry sends the same one.
    const add = Effect.gen(function* () {
      const text = yield* draft.state.get;
      yield* Generated.send(props.notes, { _tag: "Add", text, pinned: false });
      yield* draft.send(Value.Set(""));
    });
    return (
      <form onSubmit={View.submit(add)}>
        <input
          name="draft"
          value={View.bind(draft.state)}
          onInput={View.event((event) => draft.send(Value.Set(event.value)))}
        />
        <button type="submit" disabled={View.bind(empty)}>
          add
        </button>
      </form>
    );
  });
// #endregion local-state

// #region url-state
// A filter the URL keeps, and the page's data may read, is the segment's
// search. `withDefault` fills a missing key.
export const tasks = Route.segment("tasks", {
  path: "/tasks",
  search: Route.search(
    Schema.Struct({
      filter: Schema.Literals(["all", "open", "done"]).pipe(Route.withDefault("all")),
    }),
  ),
});

// A view keeps its own state in the URL with `UrlState`: it claims keys the
// route does not hold, and its codec decodes an absent key.
const Panel = Route.search(
  Schema.Struct({ panel: Schema.Literals(["closed", "open"]).pipe(Route.withDefault("closed")) }),
);

export const TasksView = (props: Route.PropsOf<typeof tasks>) =>
  Effect.gen(function* () {
    const panel = yield* UrlState.make(Panel);
    return (
      <section>
        <p id="filter">{View.bind(props.search, (search) => search.filter)}</p>
        {/* A search move takes a value, or an updater of the latest one. */}
        <button id="open" onClick={View.event(props.replaceSearch({ filter: "open" }))}>
          open
        </button>
        <button
          id="all"
          onClick={View.event(props.pushSearch((search) => ({ ...search, filter: "all" })))}
        >
          all
        </button>
        <button id="details" onClick={View.event(panel.push({ panel: "open" }))}>
          details
        </button>
        <p id="panel">{View.bind(panel.state, (state) => state.panel)}</p>
      </section>
    );
  });

export const Tasks = Route.client("tasks", Route.leaf(tasks, TasksView));
// #endregion url-state
