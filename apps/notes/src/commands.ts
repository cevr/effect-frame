import type { LocalActorRef, RemoteActorRef, SetValue } from "@effect-frame/actor/client";
import { CommandId, Value } from "@effect-frame/actor/client";
import { Effect, Random, Schema } from "effect";
import type { Notes, NotesMessage } from "./contract.js";

/**
 * The client owns the command id. One user action makes one id, so a retry
 * of the same action is idempotent and the mailbox applies it once. See
 * issue #5 for the contract this follows.
 *
 * `Random.next` keeps the id inside Effect: no global `crypto` call, and a
 * test may seed it. Two draws give the id enough width for one page.
 */
const toCommandId = Schema.decodeSync(CommandId);

export const freshId: Effect.Effect<string> = Effect.map(
  Effect.all([Random.next, Random.next]),
  ([high, low]) => `${high.toString(36).slice(2)}${low.toString(36).slice(2)}`,
);

export type NotesRef = RemoteActorRef<typeof Notes>;

/**
 * Send one message and swallow nothing quietly: every expected failure is
 * logged, because a view has no place to return one.
 */
export const dispatch = Effect.fn("Notes.dispatch")(function* (
  notes: NotesRef,
  message: NotesMessage,
) {
  const commandId = yield* freshId;
  yield* Effect.catchCause(notes.send(message, { commandId: toCommandId(commandId) }), (cause) =>
    Effect.logError("notes: send failed", cause),
  );
});

export type DraftRef = LocalActorRef<string, SetValue<string>>;

/**
 * Write the draft text. The draft actor dies with the view, so a keystroke
 * that arrives after the scope closed has nothing left to do.
 */
export const writeDraft =
  (draft: DraftRef) =>
  (text: string): Effect.Effect<void> =>
    Effect.catchTag(draft.send(Value.Set(text)), "ActorStopped", () => Effect.void).pipe(
      Effect.asVoid,
    );

/** A new note needs its own id as well as its command id. */
export const addNote = Effect.fn("Notes.addNote")(function* (notes: NotesRef, text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  const id = yield* freshId;
  yield* dispatch(notes, { _tag: "Add", id, text: trimmed });
});
