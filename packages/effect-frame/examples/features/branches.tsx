import { Source } from "effect-frame/actor/client";
import { Match, View } from "effect-frame/view";
import { Effect, Option } from "effect";

// #region union-match
/** A search hit's citation: its reference code and link, when it has them. */
export interface Hit {
  readonly refcode: Option.Option<string>;
  readonly url: Option.Option<string>;
}

/** The three ways a citation draws, as one union: no `Show` inside a `Show`. */
export type Cite =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unlinked"; readonly refcode: string }
  | { readonly _tag: "Linked"; readonly refcode: string; readonly url: string };

const citeOf = (hit: Hit): Cite =>
  Option.match(hit.refcode, {
    onNone: (): Cite => ({ _tag: "Missing" }),
    onSome: (refcode) =>
      Option.match(hit.url, {
        onNone: (): Cite => ({ _tag: "Unlinked", refcode }),
        onSome: (url): Cite => ({ _tag: "Linked", refcode, url }),
      }),
  });

// One source of the union, matched once. Each case gets a source of its own
// member, and a missing case does not compile.
export const Reference = (props: { readonly hit: Source<Hit> }) =>
  Effect.succeed(
    <Match
      on={Source.select(props.hit, citeOf)}
      cases={{
        Missing: () => <span class="refcode" />,
        Unlinked: (cite) => <span class="refcode">{View.bind(cite, (c) => c.refcode)}</span>,
        Linked: (cite) => (
          <a class="refcode" href={View.bind(cite, (c) => c.url)}>
            {View.bind(cite, (c) => c.refcode)}
          </a>
        ),
      }}
    />,
  );
// #endregion union-match
