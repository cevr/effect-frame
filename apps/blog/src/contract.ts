import { Generated, contract } from "effect-frame/actor/client";
import { Schema } from "effect";

/**
 * The one actor Blog has (#25 §2): the reactions to one post. Browser safe:
 * the page, the server, and the build all import it.
 */

/** A post's name in its URL: lower-case words joined by `-`. */
export const Slug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  Schema.brand("Slug"),
);
export type Slug = Schema.Schema.Type<typeof Slug>;

export const ReactionsKey = Schema.Struct({ slug: Slug });
export type ReactionsKey = Schema.Schema.Type<typeof ReactionsKey>;

/**
 * How many hearts a post has, and the id of each one. A heart is one row
 * per click, so each keeps its own id.
 */
export const ReactionsSnapshot = Schema.Struct({
  hearts: Schema.Finite,
  ids: Schema.Array(Schema.String),
});
export type ReactionsSnapshot = Schema.Schema.Type<typeof ReactionsSnapshot>;

/**
 * One heart. Its id is `Generated.freshId`, not `fromCommandId` (#32 §3):
 * the id names the row, not the command. The render draws it beside the
 * command id, so a form posted twice from one render still adds one row.
 */
export const Heart = Schema.TaggedStruct("Heart", {
  id: Generated.freshId(Schema.String),
});
export type Heart = Schema.Schema.Type<typeof Heart>;

export const Reactions = contract("Reactions", {
  version: 1,
  policy: "public",
  key: ReactionsKey,
  snapshot: ReactionsSnapshot,
  message: Heart,
});
