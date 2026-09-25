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

/** A list's name. The route's param, the actor's key and the queries share it. */
export const ListName = Schema.String.pipe(Schema.brand("ListName"));
export type ListName = Schema.Schema.Type<typeof ListName>;

export const NotesKey = Schema.Struct({ tenant: Schema.String, list: ListName });
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
  // Every caller may read a list; the server's `notes` rule refuses a send
  // to a read-only list. The rule lives only on the server (`policies.server.ts`),
  // so a client cannot foresee it and predicts the send.
  policy: "notes",
  key: NotesKey,
  snapshot: NotesSnapshot,
  message: NotesMessage,
});

/** A list the server keeps read-only: its `notes` policy refuses every send to it. */
export const readOnlyList = "archive";

/** The inbox. The terminal client shows this list. */
export const demoKey: NotesKey = { tenant: "demo", list: Schema.decodeSync(ListName)("inbox") };
