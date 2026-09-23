import { query } from "effect-frame/actor/client";
import { Option, Schema } from "effect";
import type { Note } from "./contract.js";
import { Notes } from "./contract.js";

/**
 * The two queries Notes reads (#17, #25 §1). Browser safe: contracts
 * only. The handlers are in `queries.server.ts`. Both name `Notes` in
 * `depends`, so a commit to any notes list refreshes whichever of them is
 * on screen. A list's notes are no query: the list route declares the
 * `Notes` actor itself (`segments.ts`), and the document carries its
 * snapshot for the first frame.
 */

/** A list's name as a route param. It prints as itself. */
export const ListName = Schema.String.pipe(Schema.brand("ListName"));
export type ListName = Schema.Schema.Type<typeof ListName>;

/** Which notes a list shows. Absent: every note. */
export const Filter = Schema.Literals(["open", "done"]);
export type Filter = Schema.Schema.Type<typeof Filter>;

/** The lists the index names. A list outside it still works by its URL. */
export const catalog: ReadonlyArray<ListName> = ["inbox", "errands", "reading"].map((name) =>
  Schema.decodeSync(ListName)(name),
);

export const ListEntry = Schema.Struct({ name: ListName, count: Schema.Finite });
export type ListEntry = Schema.Schema.Type<typeof ListEntry>;

/** Every catalog list whose name contains `q`, with its note count. */
export const ListIndex = query("ListIndex", {
  args: Schema.Struct({ q: Schema.optionalKey(Schema.String) }),
  result: Schema.Array(ListEntry),
  policy: "public",
  depends: [Notes],
});

export const Counts = Schema.Struct({ total: Schema.Finite, done: Schema.Finite });
export type Counts = Schema.Schema.Type<typeof Counts>;

/** How many notes one list shows under `filter`, and how many of them are done. */
export const ListCounts = query("ListCounts", {
  args: Schema.Struct({ list: ListName, filter: Schema.optionalKey(Filter) }),
  result: Counts,
  policy: "public",
  depends: [Notes],
});

/** The notes key of one list. Notes has one tenant. */
export const keyOf = (list: ListName) => ({ tenant: "demo", list });

/** Whether `filter` shows `note`. The handler and the view share this one rule. */
export const shows =
  (filter: Option.Option<Filter>) =>
  (note: Note): boolean =>
    Option.match(filter, {
      onNone: () => true,
      onSome: (only) => {
        if (only === "done") {
          return note.done;
        }
        return !note.done;
      },
    });
