import { Generated, contract } from "effect-frame/actor/client";
import { Schema } from "effect";

/**
 * The notes contract. This file is browser safe: it imports only `effect`
 * and the client entry of the actor package. The page, the terminal client,
 * and the server all import it, so all three agree on one wire.
 */

export const Note = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  done: Schema.Boolean,
});
export type Note = Schema.Schema.Type<typeof Note>;

export const NotesKey = Schema.Struct({ tenant: Schema.String, list: Schema.String });
export type NotesKey = Schema.Schema.Type<typeof NotesKey>;

export const NotesSnapshot = Schema.Struct({ notes: Schema.Array(Note) });
export type NotesSnapshot = Schema.Schema.Type<typeof NotesSnapshot>;

/**
 * A new note's id is its command id (#32). The render mints both at once,
 * so a plain form post carries the id, and a post sent twice adds one note.
 */
export const Add = Schema.TaggedStruct("Add", {
  id: Generated.fromCommandId(Schema.String),
  text: Schema.String,
});
export const Toggle = Schema.TaggedStruct("Toggle", { id: Schema.String });
export const Remove = Schema.TaggedStruct("Remove", { id: Schema.String });

export const NotesMessage = Schema.Union([Add, Toggle, Remove]);
export type NotesMessage = Schema.Schema.Type<typeof NotesMessage>;

export const Notes = contract("Notes", {
  version: 1,
  // A single-tenant demo: every caller may read and send. It says so here,
  // by name, and the server registers `Policy.allowAll` under it.
  policy: "public",
  key: NotesKey,
  snapshot: NotesSnapshot,
  message: NotesMessage,
});

/** The inbox. The terminal client shows this list. */
export const demoKey: NotesKey = { tenant: "demo", list: "inbox" };
