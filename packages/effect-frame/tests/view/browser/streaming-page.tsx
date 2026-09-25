/**
 * The page both halves of the real-browser streaming proof render: one
 * readiness boundary over one query, and a footer after it. The server
 * streams it; `streaming-app.tsx` hydrates it in WebKit or Chrome.
 */
import { query, useQuery } from "effect-frame/actor/client";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";

export const Label = query("BrowserStreamLabel", {
  version: 1,
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ label: Schema.String }),
  policy: "public",
  depends: [],
});

export const Page = (props: { readonly id: string }) =>
  Effect.gen(function* () {
    const scope = yield* View.loading({
      fallback: <p id="pending">loading</p>,
      content: Effect.gen(function* () {
        const entry = yield* useQuery(Label, { id: props.id });
        const value = yield* View.ready(entry.state, { label: "?" });
        return <p id="label">{View.bind(value, (found) => found.label)}</p>;
      }),
    });
    return (
      <section>
        {scope}
        <footer id="foot">foot</footer>
      </section>
    );
  });

const tall = (height: number) => <div style={`height: ${String(height)}px`} />;

/**
 * The same boundary far below the fold, with a page's worth of content after
 * it: the late patch lands where the reader is not looking (#31).
 */
export const TallPage = (props: { readonly id: string }) =>
  Effect.gen(function* () {
    const page = yield* Page(props);
    return (
      <article id="tall">
        {tall(4000)}
        {page}
        {tall(4000)}
      </article>
    );
  });
