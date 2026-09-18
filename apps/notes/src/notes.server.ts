import type { Layer } from "effect";
import { ActorHost, Behavior, implementTransparent } from "@effect-frame/actor";
import type { ActorTransport } from "@effect-frame/actor/client";
import { HttpTransport } from "@effect-frame/actor/client";
import { Match } from "effect";
import type { NotesMessage, NotesSnapshot } from "./contract.js";
import { Notes } from "./contract.js";

/**
 * The server half of the notes contract. The behavior is a reducer: one
 * message in, one state out. The host decides where the actor lives.
 */

const empty: NotesSnapshot = { notes: [] };

const reduce = (state: NotesSnapshot, message: NotesMessage): NotesSnapshot =>
  Match.type<NotesMessage>().pipe(
    Match.tagsExhaustive({
      Add: (add) => ({ notes: [...state.notes, { id: add.id, text: add.text, done: false }] }),
      Toggle: (toggle) => ({
        notes: state.notes.map((note) => {
          if (note.id === toggle.id) {
            return { ...note, done: !note.done };
          }
          return note;
        }),
      }),
      Remove: (remove) => ({ notes: state.notes.filter((note) => note.id !== remove.id) }),
    }),
  )(message);

export const NotesLive = implementTransparent(
  Notes,
  Behavior.reducer<NotesSnapshot, NotesMessage>({ initial: empty, reduce }),
);

/** The actors run in this process, over in-memory mailboxes. */
export const inProcess: Layer.Layer<ActorTransport> = ActorHost.layerMemory([NotesLive]);

/**
 * The actors run somewhere else, for example a celld node. This process
 * only proxies. `server.ts` picks between the two at the boundary.
 */
export const upstream = (baseUrl: string): Layer.Layer<ActorTransport> =>
  HttpTransport.layer({ baseUrl: `${baseUrl}/actors`, reconnect: HttpTransport.defaultReconnect });
