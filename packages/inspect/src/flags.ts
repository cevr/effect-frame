/* oxlint-disable effect/noNullish -- raw argv is an array of strings; an index past its end reads undefined. */
/**
 * The one argv reader for every `effect-frame` command. A command names its
 * value flags and its switches; anything else is an unknown flag. A value
 * flag takes the next word, which must not itself be a flag, and may be
 * given once.
 */
import { Effect, Schema } from "effect";

/** The arguments did not parse. The command prints its help and exits 2. */
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {
  message: Schema.String,
}) {}

/** The command was asked for its help. */
export class Help extends Schema.TaggedError<Help>()("Help", {}) {}

export const invalid = (message: string) => Effect.fail(Invalid.make({ message }));

export interface FlagSpec {
  /** Flags that take a value, such as `--url`. */
  readonly values: ReadonlySet<string>;
  /** Flags that stand alone, such as `--json`. */
  readonly switches: ReadonlySet<string>;
}

export interface Flags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

/**
 * Read `rest` against `spec`.
 *
 * ```ts
 * const flags = yield* readFlags(rest, {
 *   values: new Set(["--url", "--deadline"]),
 *   switches: new Set(["--json"]),
 * });
 * const json = flags.switches.has("--json");
 * ```
 */
export const readFlags = Effect.fn("InspectCli.readFlags")(function* (
  rest: ReadonlyArray<string>,
  spec: FlagSpec,
) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? "";
    if (spec.switches.has(flag)) {
      switches.add(flag);
      continue;
    }
    if (!spec.values.has(flag)) return yield* invalid(`unknown flag '${flag.slice(0, 32)}'`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return yield* invalid(`${flag} needs a value`);
    }
    if (values.has(flag)) return yield* invalid(`${flag} given twice`);
    values.set(flag, value);
    index += 1;
  }
  const flags: Flags = { values, switches };
  return flags;
});
