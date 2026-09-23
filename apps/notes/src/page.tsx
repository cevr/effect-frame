import type { Applied, Source } from "effect-frame/actor/client";
import { Behavior, Value, isReady, ref, select, spawn } from "effect-frame/actor/client";
import { Link, Router, link } from "effect-frame/router";
import type { Route } from "effect-frame/router";
import { For, View, orErrored, ready } from "effect-frame/view";
import { Effect, Option, Stream } from "effect";
import { notesBehavior } from "./behavior.js";
import { dispatch, writeDraft } from "./commands.js";
import type { Note, NotesSnapshot } from "./contract.js";
import { Add, Notes } from "./contract.js";
import type { Filter, ListName, ListNotes } from "./queries.js";
import { keyOf, shows } from "./queries.js";
import { list } from "./segments.js";

/**
 * One list of notes. The same view is the leaf of `/lists/:list` and of
 * `/lists/:list/print`, and it draws under every rendering mode the tree
 * mounts it with: the mode is the tree's constructor, never a branch here.
 *
 * The counts are route data (`ListCounts`). The notes are one actor
 * reference, opened by the list's body from the notes the route declared
 * (`ListNotes`), so the reference reads nothing more on either side and
 * the first frame holds the body. The body is keyed by the list's name, so
 * a move to another list opens a new body with its own reference and its
 * own compose form, and a filter change keeps both.
 */

export type ListProps = Route.PropsOf<typeof list>;

interface BodyProps {
  readonly name: ListName;
  readonly resume: Applied<NotesSnapshot>;
  readonly filter: Source<Option.Option<Filter>>;
}

const emptyNotes = (name: ListName): ListNotes => ({
  list: name,
  revision: { _tag: "Committed", value: 0 },
  state: { notes: [] },
});

/** The notes `filter` shows, as `filter` and the list change. */
const filtered = (
  notes: Source<ReadonlyArray<Note>>,
  filter: Source<Option.Option<Filter>>,
): Source<ReadonlyArray<Note>> => ({
  get: Effect.flatMap(filter.get, (only) =>
    Effect.map(notes.get, (all) => all.filter(shows(only))),
  ),
  changes: Stream.map(Stream.zipLatest(notes.changes, filter.changes), ([all, only]) =>
    all.filter(shows(only)),
  ),
});

const ListBody = (props: BodyProps) =>
  Effect.gen(function* () {
    const key = keyOf(props.name);
    // The behavior makes the reference optimistic (#19): an add shows at once.
    const notes = yield* ref(Notes, key, {
      resume: Option.some(props.resume),
      behavior: notesBehavior,
    });
    const draft = yield* spawn(Behavior.value(""));
    const setDraft = writeDraft(draft);
    // The last send's state, as its handle reports it: Sent, Admitted, Applied.
    const status = yield* spawn(Behavior.value("idle"));
    const scope = yield* Effect.scope;
    const follow = (state: Source<{ readonly _tag: string }>) =>
      Effect.forkIn(
        Stream.runForEach(state.changes, (current) => status.send(Value.Set(current._tag))),
        scope,
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
          <For each={filtered(all, props.filter)} keyBy={(note: Note) => note.id}>
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
    const first = yield* props.params.get;
    // Registered so the nearest `Loading` waits for the notes as well.
    yield* ready(yield* orErrored(props.data.notes.state), emptyNotes(first.list));
    const filter = select(props.search, (search) => Option.fromNullishOr(search.filter));
    // One body per list, and only once its notes are read: a body opens its
    // reference from them, so it never opens on a placeholder.
    const body = yield* View.list({
      each: select(props.data.notes.state, (state) => {
        if (isReady(state)) {
          return [state.value];
        }
        return [];
      }),
      keyBy: (notes: ListNotes) => notes.list,
      row: (notes) =>
        Effect.flatMap(notes.get, (current) =>
          // A list whose notes cannot be read says why, in its own place.
          Effect.catch(
            ListBody({
              name: current.list,
              resume: { revision: current.revision, state: current.state },
              filter,
            }),
            (error) => Effect.succeed(<p id="unreadable">{`notes unavailable: ${error._tag}`}</p>),
          ),
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
