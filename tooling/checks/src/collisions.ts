// oxlint-disable effect/noGlobals -- Bun.file reads the package manifest: the rule checks what a consumer installs.
import { Effect, Option } from "effect";
import { decodeSubpaths } from "./subpaths.js";

/**
 * One flat name per meaning, across a package's subpaths.
 *
 * An application imports several subpaths in one file. A name exported by
 * two of them (`Loading` as a query state and as a boundary, `mount` for a
 * view and for a router) makes the reader and the agent guess which one a
 * file means. So a value name belongs to one subpath, unless one subpath
 * re-exports another on purpose (`actor` is `actor/client` and the server
 * half; the two JSX runtimes are one module).
 *
 * It reads the runtime keys of each module, so it sees values. A type-only
 * export is outside it.
 */

/** The value names one subpath exports. */
export interface Surface {
  readonly subpath: string;
  readonly names: ReadonlyArray<string>;
}

/** A name more than one subpath exports. */
export interface Collision {
  readonly name: string;
  readonly subpaths: ReadonlyArray<string>;
}

/** `[superset, subset]`: the first re-exports every name of the second on purpose. */
export type Alias = readonly [superset: string, subset: string];

/** The subpaths of `effect-frame` that re-export another on purpose. */
export const declaredAliases: ReadonlyArray<Alias> = [
  ["./actor", "./actor/client"],
  ["./view/jsx-dev-runtime", "./view/jsx-runtime"],
];

/**
 * Every name that more than one subpath exports, after each declared
 * superset drops the names its subset already owns.
 *
 * ```ts
 * collisions([{ subpath: "./view", names: ["mount"] }, { subpath: "./router", names: ["mount"] }], []);
 * // [{ name: "mount", subpaths: ["./view", "./router"] }]
 * ```
 */
export const collisions = (
  surfaces: ReadonlyArray<Surface>,
  aliases: ReadonlyArray<Alias>,
): ReadonlyArray<Collision> => {
  const namesOf = new Map(surfaces.map((surface) => [surface.subpath, surface.names]));
  const owners = new Map<string, ReadonlyArray<string>>();
  for (const surface of surfaces) {
    const inherited = new Set(
      aliases
        .filter(([superset]) => superset === surface.subpath)
        .flatMap(([, subset]) =>
          Option.getOrElse(Option.fromNullishOr(namesOf.get(subset)), () => []),
        ),
    );
    for (const name of surface.names.filter((one) => !inherited.has(one))) {
      const before = Option.getOrElse(Option.fromNullishOr(owners.get(name)), () => []);
      owners.set(name, [...before, surface.subpath]);
    }
  }
  return Array.from(owners, ([name, subpaths]) => ({ name, subpaths })).filter(
    (one) => one.subpaths.length > 1,
  );
};

/** One collision as the gate prints it. */
export const formatCollision = (name: string, collision: Collision): string =>
  `${name} exports ${collision.name} from ${collision.subpaths.join(" and ")}`;

/**
 * The built package's value surfaces, one per subpath, loaded by the name a
 * consumer imports.
 */
export const readSurfaces = Effect.fn("Collisions.readSurfaces")(function* (
  root: string,
  directory: string,
) {
  const manifest = yield* Effect.promise(() =>
    Bun.file(`${root}/${directory}/package.json`).text(),
  );
  const { name, subpaths } = yield* decodeSubpaths(manifest);
  const surfaces = yield* Effect.forEach(subpaths, (subpath) =>
    Effect.map(
      Effect.promise((): Promise<object> => import(`${name}${subpath.key.replace(/^\./, "")}`)),
      (module): Surface => ({ subpath: subpath.key, names: Object.keys(module) }),
    ),
  );
  return { name, surfaces };
});
