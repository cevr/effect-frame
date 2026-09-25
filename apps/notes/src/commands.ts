import type { LocalValueRef, RemoteActorRef } from "effect-frame/actor/client";
import { Generated, Value } from "effect-frame/actor/client";
import { Effect } from "effect";
import type { Notes, NotesMessage } from "./contract.js";

export type NotesRef = RemoteActorRef<typeof Notes>;

/**
 * Send one message. The framework mints the command id, retries a lost
 * request within its bound, and reports every refusal as a state of the
 * returned handle, so nothing here can fail and nothing is swallowed. A view
 * that has no place for the handle may drop it: the command still runs.
 */
export const dispatch = Effect.fn("Notes.dispatch")(function* (
  notes: NotesRef,
  message: NotesMessage,
) {
  return yield* notes.send(message);
});

/**
 * Write the draft text. The draft actor dies with the view; a keystroke that
 * arrives after the scope closed gets a Rejected handle, which the view
 * drops.
 */
export const writeDraft =
  (draft: LocalValueRef<string>) =>
  (text: string): Effect.Effect<void> =>
    Effect.asVoid(draft.send(Value.Set(text)));

/**
 * Add a note. The note's id is generated from the command id, so the
 * author never writes it: `Generated.send` mints the command id and fills
 * the id from it in one step.
 */
export const addNote = Effect.fn("Notes.addNote")(function* (notes: NotesRef, text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  yield* Generated.send(notes, { _tag: "Add", text: trimmed });
});
