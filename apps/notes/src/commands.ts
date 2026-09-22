import type { LocalActorRef, RemoteActorRef, SetValue } from "effect-frame/actor/client";
import { Value } from "effect-frame/actor/client";
import { Effect, Random } from "effect";
import type { Notes, NotesMessage } from "./contract.js";

/**
 * A fresh note id. `Random.next` keeps it inside Effect, so a test may seed
 * it. Two draws give the id enough width for one page. Command ids are not
 * made here: the framework mints a secure one for every `send`.
 */
export const freshId: Effect.Effect<string> = Effect.map(
  Effect.all([Random.next, Random.next]),
  ([high, low]) => `${high.toString(36).slice(2)}${low.toString(36).slice(2)}`,
);

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

export type DraftRef = LocalActorRef<string, SetValue<string>>;

/**
 * Write the draft text. The draft actor dies with the view; a keystroke that
 * arrives after the scope closed gets a Rejected handle, which the view
 * drops.
 */
export const writeDraft =
  (draft: DraftRef) =>
  (text: string): Effect.Effect<void> =>
    Effect.asVoid(draft.send(Value.Set(text)));

/** A new note needs its own id as well as its command id. */
export const addNote = Effect.fn("Notes.addNote")(function* (notes: NotesRef, text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  const id = yield* freshId;
  yield* dispatch(notes, { _tag: "Add", id, text: trimmed });
});
