import { Actor, implementQuery } from "effect-frame/actor";
import { Effect, Option } from "effect";
import { Notes } from "./contract.js";
import type { ListName } from "./queries.js";
import { ListCounts, ListIndex, catalog, keyOf, shows } from "./queries.js";

/**
 * The query handlers (#17). A server module: a browser entry that
 * reaches it fails `bun run boundary`. Each reads the notes actor through
 * the host it runs in, as a client would.
 */

const notesOf = (list: ListName) =>
  Effect.flatMap(Actor.remote(Notes, keyOf(list)), (notes) =>
    Effect.map(notes.state.get, (snapshot) => snapshot.notes),
  );

export const ListIndexLive = implementQuery(ListIndex, {
  run: (args) =>
    Effect.forEach(
      catalog.filter((name) =>
        Option.match(Option.fromNullishOr(args.q), {
          onNone: () => true,
          onSome: (q) => name.includes(q),
        }),
      ),
      (name) => Effect.map(notesOf(name), (notes) => ({ name, count: notes.length })),
    ).pipe(Effect.scoped),
});

export const ListCountsLive = implementQuery(ListCounts, {
  run: (args) =>
    Effect.map(notesOf(args.list), (notes) => {
      const visible = notes.filter(shows(Option.fromNullishOr(args.filter)));
      return { total: visible.length, done: visible.filter((note) => note.done).length };
    }).pipe(Effect.scoped),
});
