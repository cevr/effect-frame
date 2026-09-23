/**
 * The page both halves of the real-browser prerender proof share (#86): one
 * prerender route whose view holds one actor island. The build renders it
 * to a file; `prerender-app.tsx`, bundled as the build's `client.js`,
 * hydrates that file in WebKit or Chrome.
 */
import { contract, ref, resumeCodec } from "effect-frame/actor/client";
import type { Applied, SnapshotOf } from "effect-frame/actor/client";
import { Route } from "effect-frame/router";
import type { NotFoundProps } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Context, Effect, Option, Schema } from "effect";

export const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
export const NoteSnapshot = Schema.Struct({ count: Schema.Finite });

export const Note = contract("BrowserPrerenderNote", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: NoteSnapshot,
  message: Add,
});

export const Resume = resumeCodec(Note);

/** The id of the JSON script that carries the baked snapshot. */
export const bakedId = "baked-note";

/** The snapshot the page baked, when this is the client. The build has none. */
export const Baked = Context.Reference<Option.Option<Applied<SnapshotOf<typeof Note>>>>(
  "tests/router/browser/prerender-page/Baked",
  { defaultValue: () => Option.none() },
);

const noteSegment = Route.segment("note", {
  path: "/notes/:key",
  params: Schema.Struct({ key: Schema.String }),
});

export const noteRoute = Route.prerender(
  "notes",
  Route.leaf(noteSegment, () =>
    Effect.gen(function* () {
      const note = yield* Effect.orDie(ref(Note, "n1", { resume: yield* Baked }));
      return (
        <article id="note">
          <p id="count">{View.bind(note.state, (state) => state.count)}</p>
        </article>
      );
    }),
  ),
  { inputs: [Route.inputs(noteSegment, Effect.succeed([{ key: "n1" }]))] },
);

export const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">not found</p>);
