import { Behavior } from "effect-frame/actor/client";
import { Match } from "effect";
import type { NotesMessage, NotesSnapshot } from "./contract.js";

/**
 * The notes behavior: one message in, one state out. It is browser safe,
 * so the server runs it and the page predicts with it (#19): an add shows
 * in the same turn, before the server commits it.
 */

const empty: NotesSnapshot = { notes: [] };

const reduce = (state: NotesSnapshot, message: NotesMessage): NotesSnapshot =>
  Match.type<NotesMessage>().pipe(
    Match.tagsExhaustive({
      Add: (add) => ({ notes: [...state.notes, { id: add.id, text: add.text, done: false }] }),
      Toggle: (toggle) => ({
        notes: state.notes.map((note) => {
          if (note.id === toggle.id) {
            return { ...note, done: !note.done };
          }
          return note;
        }),
      }),
      Remove: (remove) => ({ notes: state.notes.filter((note) => note.id !== remove.id) }),
    }),
  )(message);

export const notesBehavior = Behavior.reducer<NotesSnapshot, NotesMessage>({
  initial: empty,
  reduce,
});
