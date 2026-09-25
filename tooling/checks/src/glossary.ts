import { Option } from "effect";

/**
 * One owner per word, as a build rule.
 *
 * `CONTEXT.md` is the glossary: each term is a line `**Term**:` followed by
 * its definition. A term written twice drifts, one copy edited and the
 * other not, and a reader cannot tell which one is meant. So the rule
 * refuses a term defined a second time, at the second definition.
 */

/** A term defined more than once: the line of its repeat and of its first definition, 1-based. */
export interface RepeatedTerm {
  readonly term: string;
  readonly line: number;
  readonly first: number;
}

const definition = /^\*\*([^*]+)\*\*:\s*$/;

/** Every term the glossary defines again after its first definition. */
export const repeatedTerms = (markdown: string): ReadonlyArray<RepeatedTerm> => {
  const seen = new Map<string, number>();
  return markdown.split("\n").flatMap((text, index): ReadonlyArray<RepeatedTerm> =>
    Option.match(Option.fromNullishOr(definition.exec(text.trimEnd())), {
      onNone: () => [],
      onSome: (match) => {
        const term = match[0].slice(2, -3).trim();
        const line = index + 1;
        return Option.match(Option.fromNullishOr(seen.get(term)), {
          onNone: () => {
            seen.set(term, line);
            return [];
          },
          onSome: (first) => [{ term, line, first }],
        });
      },
    }),
  );
};

/** One repeated term as the gate prints it. */
export const formatRepeat = (file: string, repeat: RepeatedTerm): string =>
  `${file}:${String(repeat.line)}: term "${repeat.term}" is defined again (first at line ${String(repeat.first)})`;
