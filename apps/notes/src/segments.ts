import { Route } from "effect-frame/router";
import { Effect, Schema } from "effect";
import { Filter, ListCounts, ListIndex, ListName, ListNotes } from "./queries.js";

/**
 * The addresses of the Notes route tree (#18, #25 §1): each segment's path,
 * its codecs, and the data it declares. No view lives here, so the views
 * can name the segments they link to and the tree can name the views.
 *
 * ```
 * shell    /
 * ├─ lists     /lists               ListIndex {}          (the list names)
 * │  ├─ index  /lists?q=            ListIndex {q}
 * │  ├─ list   /lists/:list?filter= ListCounts {list, filter}, ListNotes {list}
 * │  └─ print  /lists/:list/print   ListCounts {list, filter}, ListNotes {list}
 * └─ scratch   /scratch             nothing
 * home     /  redirects to /lists
 * ```
 */

export const NoParams = Schema.Struct({});
export const ListParams = Schema.Struct({ list: ListName });
export type ListParams = Schema.Schema.Type<typeof ListParams>;

export const shell = Route.segment("shell", { path: "/", params: NoParams });

/** Every page under `/lists` shows the list names, from one shared key. */
export const lists = Route.child(shell, "lists", {
  path: "lists",
  params: NoParams,
  data: () => ({ names: Route.query(ListIndex, {}) }),
});

export const IndexSearch = Route.search(Schema.Struct({ q: Schema.optionalKey(Schema.String) }));

/** The list names that match `q`. With no `q`, this is the key `lists` declares. */
export const index = Route.child(lists, "index", {
  path: "",
  params: NoParams,
  search: IndexSearch,
  data: ({ search }) => ({ found: Route.query(ListIndex, search) }),
});

export const ListSearch = Route.search(Schema.Struct({ filter: Schema.optionalKey(Filter) }));
export type ListSearch = Schema.Schema.Type<typeof ListSearch>;

/**
 * One list's counts under its filter, and its notes to resume from. The
 * list page and its print page declare both. A filter change moves only
 * the counts: the notes key has no filter.
 */
const listData = ({ params, search }: Route.Values<ListParams, ListSearch>) => ({
  counts: Route.query(ListCounts, { list: params.list, ...search }),
  notes: Route.query(ListNotes, { list: params.list }),
});

export const list = Route.child(lists, "list", {
  path: ":list",
  params: ListParams,
  search: ListSearch,
  data: listData,
});

/** The print page of one list: the list page's codecs and data at another path. */
export const print = Route.child(lists, "print", {
  path: ":list/print",
  params: ListParams,
  search: ListSearch,
  data: listData,
});

/** A page with no server data: a local draft, drawn on the client only. */
export const scratch = Route.child(shell, "scratch", { path: "scratch", params: NoParams });

/** `/` has no page of its own: it sends the reader to the lists. */
export const home = Route.segment("home", {
  path: "/",
  params: NoParams,
  before: () => Effect.succeed(Route.redirect(Route.target(index, {}, {}))),
});
