import type { Applied, SnapshotOf } from "effect-frame/actor/client";
import { Behavior, ref, select, spawn } from "effect-frame/actor/client";
import { For, View } from "effect-frame/view";
import type { Option } from "effect";
import { Effect } from "effect";
import { addNote, writeDraft } from "./commands.js";
import type { Note, NotesKey } from "./contract.js";
import { Notes } from "./contract.js";

/**
 * The terminal page. Setup is the same as the browser page: one `ref`, one
 * local draft, the same `addNote`. Only the tags differ, because a terminal
 * has `box`, `text`, and `input` where a browser has `section`, `ul`, and
 * `li`. The host interface is what the two views share; the tags are not.
 */

export interface NotesTerminalProps {
  readonly key: NotesKey;
  readonly resume: Option.Option<Applied<SnapshotOf<typeof Notes>>>;
}

const line = (note: Note): string => {
  if (note.done) {
    return `[x] ${note.text}`;
  }
  return `[ ] ${note.text}`;
};

export const NotesTerminal = (props: NotesTerminalProps) =>
  Effect.gen(function* () {
    const notes = yield* ref(Notes, props.key, { resume: props.resume });
    const draft = yield* spawn(Behavior.value(""));
    const setDraft = writeDraft(draft);

    return (
      <box flexDirection="column" width={48}>
        <text>{View.bind(notes.state, (snapshot) => `notes: ${snapshot.notes.length}`)}</text>
        <box flexDirection="column">
          <For
            each={select(notes.state, (snapshot) => snapshot.notes)}
            keyBy={(note: Note) => note.id}
          >
            {(note) => <text>{View.bind(note, line)}</text>}
          </For>
        </box>
        <input
          width={40}
          onInput={View.event((event) => setDraft(event.value))}
          onEnter={View.event(() =>
            Effect.flatMap(draft.state.get, (text) =>
              Effect.andThen(addNote(notes, text), setDraft("")),
            ),
          )}
        />
      </box>
    );
  });
