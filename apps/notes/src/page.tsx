import type { RemoteActorRef } from "effect-frame/actor/client";
import { Behavior, Source, Value, select, spawn } from "effect-frame/actor/client";
import { Link, Router, link } from "effect-frame/router";
import type { Route } from "effect-frame/router";
import { For, View, orErrored, ready } from "effect-frame/view";
import { Effect, Option, Scope } from "effect";
import { dispatch, writeDraft } from "./commands.js";
import type { Note } from "./contract.js";
import { Add, Notes } from "./contract.js";
import type { Filter, ListName } from "./queries.js";
import { keyOf, shows } from "./queries.js";
import { list } from "./segments.js";

/**
 * One list of notes. The same view is the leaf of `/lists/:list` and of
 * `/lists/:list/print`, and it draws under every rendering mode the tree
 * mounts it with: the mode is the tree's constructor, never a branch here.
 *
 * The counts are route data (`ListCounts`). The notes are route data too:
 * the route declares the `Notes` actor and opens its reference with the
 * behavior, from the snapshot the document carries, so the first frame
 * holds the body on both sides and nothing reads the actor again. The body
 * is keyed by the list's name, so a move to another list opens a new body
 * with the route's new reference and its own compose form, and a filter
 * change keeps both.
 */

export type ListProps = Route.PropsOf<typeof list>;

interface BodyProps {
  readonly name: ListName;
  readonly notes: RemoteActorRef<typeof Notes>;
  readonly filter: Source<Option.Option<Filter>>;
}

/** The list the route shows and the reference it opened for it, published together. */
interface Opened {
  readonly name: ListName;
  readonly notes: RemoteActorRef<typeof Notes>;
}

/** The notes `filter` shows, as `filter` and the list change. */
const filtered = (
  notes: Source<ReadonlyArray<Note>>,
  filter: Source<Option.Option<Filter>>,
): Source<ReadonlyArray<Note>> => Source.zip(notes, filter, (all, only) => all.filter(shows(only)));

const ListBody = (props: BodyProps) =>
  Effect.gen(function* () {
    const key = keyOf(props.name);
    // The route's reference predicts with the behavior (#19): an add shows at once.
    const notes = props.notes;
    const draft = yield* spawn(Behavior.value(""));
    const setDraft = writeDraft(draft);
    // The last send's state, as its handle reports it: Sent, Admitted, Applied.
    const status = yield* spawn(Behavior.value("idle"));
    const scope = yield* Effect.scope;
    const follow = (state: Source<{ readonly _tag: string }>) =>
      Source.on(state, (current) => status.send(Value.Set(current._tag))).pipe(
        Scope.provide(scope),
      );

    const here = yield* (yield* Router).current.get;
    const compose = yield* View.form({
      ref: notes,
      contract: Notes,
      key,
      message: Add,
      typed: ["text"],
      endpoint: "/actors",
      // A post with no script returns to the page it came from: the print
      // page draws the form whole, and a streamed page draws it only once
      // its script runs.
      returnTo: here.url.pathname,
      onSend: (handle) => Effect.andThen(follow(handle.state), setDraft("")),
    });

    const every = yield* link(list, { list: props.name }, {});
    const open = yield* link(list, { list: props.name }, { filter: "open" });
    const done = yield* link(list, { list: props.name }, { filter: "done" });
    const all = select(notes.state, (snapshot) => snapshot.notes);

    return (
      <section id="notes-page" data-list={props.name}>
        <nav id="filters">
          <Link link={every}>all</Link> <Link link={open}>open</Link> <Link link={done}>done</Link>
        </nav>
        <form id="compose" onSubmit={compose.submit}>
          <input
            id="draft"
            name="text"
            value={View.bind(draft.state)}
            onInput={View.event((event) => setDraft(event.value))}
          />
          <button id="add" type="submit">
            add
          </button>
          <output id="status">{View.bind(status.state)}</output>
        </form>
        <ul id="issues">
          {compose.issues.map((issue) => (
            <li data-field={issue.field}>{issue.message}</li>
          ))}
        </ul>
        <ul id="list">
          <For each={filtered(all, props.filter)} keyBy={(note) => note.id}>
            {(note) => (
              <li>
                <input
                  type="checkbox"
                  checked={View.bind(note, (value) => value.done)}
                  onChange={View.event(() =>
                    Effect.flatMap(note.get, (value) =>
                      dispatch(notes, { _tag: "Toggle", id: value.id }),
                    ),
                  )}
                />
                <span>{View.bind(note, (value) => value.text)}</span>
                <button
                  type="button"
                  onClick={View.event(() =>
                    Effect.flatMap(note.get, (value) =>
                      dispatch(notes, { _tag: "Remove", id: value.id }),
                    ),
                  )}
                >
                  remove
                </button>
              </li>
            )}
          </For>
        </ul>
        <p id="count">{View.bind(all, (shown) => shown.length)}</p>
      </section>
    );
  });

export const ListView = (props: ListProps) =>
  Effect.gen(function* () {
    // A failed read goes to the nearest `Errored`, and only that read does.
    const counts = yield* ready(yield* orErrored(props.data.counts.state), { total: 0, done: 0 });
    const filter = select(props.search, (search) => Option.fromNullishOr(search.filter));
    // The route publishes its params and its reference together, so the pair
    // read here always names one list.
    const opened = (notes: RemoteActorRef<typeof Notes>) =>
      Effect.map(props.params.get, (params): ReadonlyArray<Opened> => [
        { name: params.list, notes },
      ]);
    // One body per list: a new list is a new body over the route's new reference.
    const body = yield* View.list({
      each: Source.mapEffect(props.data.notes, opened),
      keyBy: (one: Opened) => one.name,
      row: (one) =>
        Effect.flatMap(one.get, (current) =>
          ListBody({ name: current.name, notes: current.notes, filter }),
        ),
    });
    return (
      <article id="list-page">
        <h1 id="list-name">{View.bind(props.params, (params) => params.list)}</h1>
        <p id="counts">{View.bind(counts, (value) => `${value.done} of ${value.total} done`)}</p>
        {body}
      </article>
    );
  });
