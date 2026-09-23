import type { Applied, SnapshotOf } from "effect-frame/actor/client";
import { Behavior, ref, select, spawn } from "effect-frame/actor/client";
import { For, View } from "effect-frame/view";
import type { Option } from "effect";
import { Effect } from "effect";
import { dispatch, writeDraft } from "./commands.js";
import type { Note, NotesKey } from "./contract.js";
import { Add, Notes } from "./contract.js";

/**
 * The browser page. One view, one actor reference. The list, the count, and
 * every row read the same remote snapshot; every button sends a message.
 *
 * The draft text lives in a local actor. Local UI state stays local; the
 * notes themselves are the server's.
 *
 * The compose form is a command form (#21). With no script it posts to
 * `/actors/form` and the browser comes back to `/`; with the script it
 * sends the same message over the transport and clears the draft.
 */

export interface NotesPageProps {
  readonly key: NotesKey;
  /** The snapshot the server embedded, when this is the hydrating client. */
  readonly resume: Option.Option<Applied<SnapshotOf<typeof Notes>>>;
}

export const NotesPage = (props: NotesPageProps) =>
  Effect.gen(function* () {
    const notes = yield* ref(Notes, props.key, { resume: props.resume });
    const draft = yield* spawn(Behavior.value(""));
    const setDraft = writeDraft(draft);

    const compose = yield* View.form({
      ref: notes,
      contract: Notes,
      key: props.key,
      message: Add,
      typed: ["text"],
      endpoint: "/actors",
      returnTo: "/",
      onSend: () => setDraft(""),
    });

    return (
      <section id="notes-page">
        <form id="compose" onSubmit={compose.submit}>
          <input
            id="draft"
            name="text"
            value={View.bind(draft.state)}
            onInput={View.event((event) => setDraft(event.value))}
          />
          <button type="submit">add</button>
        </form>
        <ul id="issues">
          {compose.issues.map((issue) => (
            <li data-field={issue.field}>{issue.message}</li>
          ))}
        </ul>
        <ul id="list">
          <For
            each={select(notes.state, (snapshot) => snapshot.notes)}
            keyBy={(note: Note) => note.id}
          >
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
        <p id="count">{View.bind(notes.state, (snapshot) => snapshot.notes.length)}</p>
      </section>
    );
  });
