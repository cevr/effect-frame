import { Effect, Option, Schema } from "effect";

/**
 * The server/client boundary, as a build rule.
 *
 * A browser entry may not reach a server module. "Server module" is a file
 * convention, not a wrapper and not a directive: a file whose basename ends
 * in `.server` before its extension. The rule also refuses the full
 * `effect-frame/actor` entry, which re-exports hosts, stores, and
 * implementations; a browser entry imports `effect-frame/actor/client`.
 *
 * The rule runs the real bundler over each browser entry and reads the
 * import graph it reports, so what the rule refuses is exactly what a page
 * would download. A lint that reads imports one file at a time cannot see a
 * leak three files deep; the bundler's graph does.
 */

/** A file is server-only when its basename ends in `.server` before the extension. */
const serverSuffix = /\.server\.[cm]?[jt]sx?$/;

/** Package entries that carry server code and must never be a browser import. */
const serverEntries: ReadonlySet<string> = new Set(["effect-frame/actor"]);

/** One refused import, with the chain of files that reached it. */
export interface Violation {
  /** Why the import is refused, in one phrase. */
  readonly reason: string;
  /** Absolute file paths from the entry to the importer, then the refused specifier as written. */
  readonly chain: ReadonlyArray<string>;
}

/** A source text that replaces a file on disk for one check. */
export interface SourceEdit {
  /** Absolute path of the file the edit replaces. */
  readonly path: string;
  readonly contents: string;
}

/** The bundler could not build the entry, so the rule cannot read its graph. */
export class BoundaryBuildFailed extends Schema.TaggedError<BoundaryBuildFailed>()(
  "BoundaryBuildFailed",
  {
    entry: Schema.String,
    messages: Schema.Array(Schema.String),
  },
) {}

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly original: string;
}

const reasonFor = (edge: Edge): Option.Option<string> => {
  if (serverSuffix.test(edge.to)) {
    return Option.some("a server module (*.server.*)");
  }
  if (serverEntries.has(edge.original)) {
    return Option.some("the full actor entry (use effect-frame/actor/client)");
  }
  return Option.none();
};

/** Walk back up the parent links to name every file that reached the importer. */
const chainTo = (importer: string, parent: ReadonlyMap<string, string>): Array<string> => {
  const chain: Array<string> = [];
  let current = Option.some(importer);
  while (Option.isSome(current)) {
    chain.unshift(current.value);
    current = Option.fromNullishOr(parent.get(current.value));
  }
  return chain;
};

/**
 * Breadth first from the entry, so each violation carries its shortest
 * chain. A refused module is reported once and not entered: its own imports
 * are server code by definition, and the first refusal is the one to fix.
 */
const violationsOf = (
  entry: string,
  graph: ReadonlyMap<string, ReadonlyArray<Edge>>,
): ReadonlyArray<Violation> => {
  const parent = new Map<string, string>();
  const seen = new Set<string>([entry]);
  const refused = new Set<string>();
  const violations: Array<Violation> = [];
  const queue: Array<string> = [entry];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index] ?? entry;
    for (const edge of graph.get(from) ?? []) {
      const reason = reasonFor(edge);
      if (Option.isSome(reason)) {
        if (!refused.has(edge.to)) {
          refused.add(edge.to);
          violations.push({
            reason: reason.value,
            chain: [...chainTo(from, parent), edge.original],
          });
        }
      } else if (!seen.has(edge.to)) {
        seen.add(edge.to);
        parent.set(edge.to, from);
        queue.push(edge.to);
      }
    }
  }
  return violations;
};

/**
 * Bundle one browser entry and return every server import it reaches. An
 * empty array means the entry is clean. `edits` replace files on disk for
 * this check only, so a test can inject a leak without writing a file.
 */
export const checkEntry = Effect.fn("Boundary.checkEntry")(function* (
  entry: string,
  edits: ReadonlyArray<SourceEdit> = [],
) {
  const result = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [entry],
      target: "browser",
      conditions: ["source"],
      metafile: true,
      throw: false,
      files: Object.fromEntries(edits.map((edit) => [edit.path, edit.contents])),
    }),
  );
  if (!result.success) {
    return yield* BoundaryBuildFailed.make({
      entry,
      messages: result.logs.map((log) => log.message),
    });
  }
  // The metafile names every file relative to the working directory.
  const base = new URL(`file://${process.cwd()}/`);
  const absolute = (relative: string): string => new URL(relative, base).pathname;
  const inputs = Object.entries(result.metafile?.inputs ?? {});
  const graph = new Map(
    inputs.map(([file, input]): readonly [string, ReadonlyArray<Edge>] => {
      const from = absolute(file);
      const edges = input.imports.map((one): Edge => ({
        from,
        to: absolute(one.path),
        // The bundler omits the written specifier for imports it synthesised itself.
        original: one.original ?? one.path,
      }));
      return [from, edges];
    }),
  );
  return violationsOf(entry, graph);
});

/** Render one violation as the path chain that reached the server module. */
export const formatViolation = (violation: Violation, root: string): string => {
  const [first = "", ...rest] = violation.chain.map((step) => step.replace(root, "."));
  const hops = rest.map((step, index) => `${"  ".repeat(index + 2)}-> ${step}`);
  return [`refused ${violation.reason}:`, `  ${first}`, ...hops].join("\n");
};
