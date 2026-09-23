/**
 * The page both halves of the real-browser streaming proof render: one
 * readiness boundary over one query, and a footer after it. The server
 * streams it; `streaming-app.tsx` hydrates it in WebKit or Chrome.
 */
import { query, useQuery } from "effect-frame/actor/client";
import { Loading, View, ready } from "effect-frame/view";
import { Effect, Schema } from "effect";

export const Label = query("BrowserStreamLabel", {
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ label: Schema.String }),
  policy: "public",
});

export const Page = (props: { readonly id: string }) =>
  Effect.gen(function* () {
    const scope = yield* Loading({
      fallback: <p id="pending">loading</p>,
      children: Effect.gen(function* () {
        const entry = yield* useQuery(Label, { id: props.id });
        const value = yield* ready(entry.state, { label: "?" });
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
