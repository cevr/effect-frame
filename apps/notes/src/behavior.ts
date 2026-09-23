import { Behavior, Refused } from "effect-frame/actor/client";
import { Match, Option } from "effect";
import type { NotesMessage, NotesSnapshot } from "./contract.js";

/**
 * The notes behavior: one message in, one state out. It is browser safe,
 * so the server runs it and the page predicts with it (#19): an add shows
 * in the same turn, before the server commits it. It refuses one message,
 * an add of `"reject-me"` (#25 §1): the host answers that add
 * `Rejected(Refused)`, and the page, predicting with this same rule, never
 * shows it.
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

/** The one text this behavior refuses to add. */
export const refusedText = "reject-me";

const refuse = (message: NotesMessage): Option.Option<Refused> => {
  if (message._tag === "Add" && message.text === refusedText) {
    return Option.some(Refused.make({ reason: `a note cannot say "${refusedText}"` }));
  }
  return Option.none();
};

export const notesBehavior = Behavior.reducer<NotesSnapshot, NotesMessage, Refused>({
  initial: empty,
  reduce,
  refuse,
});
