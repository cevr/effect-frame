import { Effect, Option, Schema } from "effect";

/**
 * No package goes to 1.0 by accident.
 *
 * On a 0.x package a `major` changeset makes the first major release,
 * 1.0.0. The changesets CLI warns about that only in the interactive
 * `changeset add`; a changeset written by hand never sees the warning. So
 * the gate refuses, while `firstMajor` is false:
 *
 * - a `major` bump in `.changeset/*.md` of a package whose version is
 *   below 1.0.0, at the line of the bump;
 * - a published package whose version is 1.0.0 or above. This catches the
 *   Version PR, where `changeset version` has already consumed the
 *   changesets.
 *
 * Setting `firstMajor` to true is the written decision to release 1.0.
 */

/** The owner's decision to make a first major release. */
export const firstMajor: boolean = false;

/** A workspace package, as its manifest names it. */
export interface Workspace {
  readonly name: string;
  readonly version: string;
  /** Not `private`: `changeset publish` releases it. */
  readonly published: boolean;
}

const bump = /^\s*["']?([^"':\s]+)["']?\s*:\s*major\s*$/;
const fence = /^---\s*$/;
const decision = "set firstMajor in tooling/checks/src/changesets.ts";

const majorOf = (version: string): number => Number(version.split(".")[0]);

/** The front matter of a changeset: the lines between its two `---` fences. */
const frontMatter = (text: string): ReadonlyArray<string> => {
  const [first, ...rest] = text.split("\n");
  const end = rest.findIndex((line) => fence.test(line));
  if (!Option.exists(Option.fromNullishOr(first), (line) => fence.test(line)) || end < 0) {
    return [];
  }
  return rest.slice(0, end);
};

/** Each `major` bump in a changeset's front matter, with its 1-based line. */
const majorBumps = (
  text: string,
): ReadonlyArray<{ readonly name: string; readonly line: number }> =>
  frontMatter(text).flatMap((line, index) =>
    Option.toArray(Option.fromNullishOr(bump.exec(line)?.[1])).map((name) => ({
      name,
      line: index + 2,
    })),
  );

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    private: Schema.optionalKey(Schema.Boolean),
  }),
);

/** A workspace package from its manifest's text. */
export const decodeWorkspace = (manifest: string) =>
  Effect.map(Schema.decodeEffect(Manifest)(manifest), (decoded): Workspace => ({
    name: decoded.name,
    version: decoded.version,
    published: decoded.private !== true,
  }));

/**
 * Every refusal of the rule, as the gate prints it. `changesets` maps a
 * file name in `.changeset/` to its text.
 */
export const accidentalMajors = (
  decided: boolean,
  workspace: ReadonlyArray<Workspace>,
  changesets: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  if (decided) {
    return [];
  }
  const versions = new Map(workspace.map((entry) => [entry.name, entry.version]));
  const bumps = [...changesets].flatMap(([file, text]) =>
    majorBumps(text).flatMap(({ name, line }) =>
      Option.match(
        Option.filter(Option.fromNullishOr(versions.get(name)), (version) => majorOf(version) < 1),
        {
          onNone: () => [],
          onSome: (version) => [
            `.changeset/${file}:${String(line)}: "${name}": major takes ${name} from ${version} to 1.0.0; bump minor, or ${decision}`,
          ],
        },
      ),
    ),
  );
  const released = workspace
    .filter((entry) => entry.published && majorOf(entry.version) >= 1)
    .map(
      (entry) =>
        `${entry.name} is ${entry.version}: its first major release is a decision; ${decision}`,
    );
  return [...bumps, ...released];
};
