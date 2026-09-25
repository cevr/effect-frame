import type { RemoteActorRef } from "effect-frame/actor/client";
import { Behavior, Form, Generated, contract } from "effect-frame/actor/client";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";

// #region message
// The render mints `id` from the form's command id; decoding never mints it.
// A checkbox posts nothing when unchecked, so `Form.Checkbox` reads absent
// as false.
export const Add = Schema.TaggedStruct("Add", {
  id: Generated.fromCommandId(Schema.String),
  text: Schema.String,
  pinned: Form.Checkbox,
});
// #endregion message
export type Add = Schema.Schema.Type<typeof Add>;

export const Notes = contract("Notes", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ list: Schema.String }),
  snapshot: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  message: Add,
});

export const notesBehavior = Behavior.reducer<
  ReadonlyArray<{ readonly id: string; readonly text: string }>,
  Add
>({
  initial: [],
  reduce: (notes, add) => [...notes, { id: add.id, text: add.text }],
});

// #region compose
// `typed` names the fields the reader types; the runtime writes the rest
// (method, action, and the hidden command fields) in every host.
export const Compose = (props: { readonly notes: RemoteActorRef<typeof Notes> }) =>
  Effect.gen(function* () {
    const add = yield* View.form({
      ref: props.notes,
      message: Add,
      typed: ["text", "pinned"],
      endpoint: "/actors",
      returnTo: "/",
    });
    return (
      <form onSubmit={add.submit}>
        <input name="text" />
        <input type="checkbox" name="pinned" />
        <button type="submit">add</button>
        {add.issues.map((issue) => (
          <p>{issue.message}</p>
        ))}
      </form>
    );
  });

// From code, `Generated.send` sends the input without its generated fields.
export const addFromCode = (notes: RemoteActorRef<typeof Notes>) =>
  Generated.send(notes, { _tag: "Add", text: "hello", pinned: false });
// #endregion compose
