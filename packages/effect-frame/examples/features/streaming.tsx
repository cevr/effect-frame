import { QueryCache } from "effect-frame/actor/client";
import { For, View } from "effect-frame/view";
import { Effect } from "effect";
import { CounterNames } from "../counter/contract.js";

/** A page that waits on one query: the shell draws the fallback first. */
export const NamesPage = (props: { readonly title: string }) =>
  View.loading({
    fallback: <p>loading</p>,
    content: Effect.gen(function* () {
      const entry = yield* QueryCache.use((cache) => cache.open(CounterNames, {}));
      const names = yield* View.ready(entry.state, []);
      return (
        <section>
          <h1>{props.title}</h1>
          <ul>
            <For each={names} keyBy={(name) => name}>
              {(name) => <li>{View.bind(name)}</li>}
            </For>
          </ul>
        </section>
      );
    }),
  });
