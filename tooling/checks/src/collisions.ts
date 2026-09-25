// oxlint-disable effect/noGlobals -- Bun.file reads the package manifest: the rule checks what a consumer installs.
import { Effect, Option, Predicate } from "effect";
import { decodeSubpaths } from "./subpaths.js";

/**
 * One flat name per meaning, across a package's subpaths.
 *
 * An application imports several subpaths in one file. A name exported by
 * two of them (`Loading` as a query state and as a boundary, `mount` for a
 * view and for a router) makes the reader and the agent guess which one a
 * file means. So a value name belongs to one subpath, unless one subpath
 * re-exports another on purpose (`actor` is `actor/client` and the server
 * half; every JSX runtime, the terminal's included, is one module).
 *
 * A value also has one path (`duplicatePaths`): one flat name, or one
 * member of one namespace, never both.
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
  ["./view/opentui/jsx-runtime", "./view/jsx-runtime"],
  ["./view/opentui/jsx-dev-runtime", "./view/jsx-runtime"],
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

/**
 * Paths that must name one value, because a compiler asks for each name:
 * the automatic JSX transform imports `jsx`, `jsxs`, and `jsxDEV`.
 */
export const declaredSynonyms: ReadonlyArray<ReadonlyArray<string>> = [
  ["./view/jsx-runtime jsx", "./view/jsx-runtime jsxDEV", "./view/jsx-runtime jsxs"],
];

/** One subpath's loaded module: each export name and its value. */
export interface Loaded {
  readonly subpath: string;
  readonly module: object;
}

/** How an ES module namespace object (`export * as X`) names itself. */
const namespaceTag = "[object Module]";

/**
 * The exports of a module that have an identity: a function, a class, or an
 * object. A constant (a string, a number) has none.
 */
// oxlint-disable-next-line effect/noObjectParameters -- a module exports whatever it exports: the rule reads its values by identity, not by shape.
const valuesOf = (module: object): ReadonlyArray<readonly [string, object]> =>
  Object.entries(module).filter((entry): entry is [string, object] =>
    Predicate.isObjectKeyword(entry[1]),
  );

/**
 * Every value a reader can import by more than one path, as the paths,
 * `"<subpath> <name>"` or `"<subpath> <Namespace>.<member>"`.
 *
 * A second path to one value (`UrlStateConflict` beside
 * `UrlState.UrlStateConflict`) makes an application write it two ways and
 * an agent guess which one the codebase means. So each value has one path:
 * one flat name, or one member of one namespace, one level deep. A declared
 * superset carries its subset's names and is not read for them, and a
 * declared synonym set (`declaredSynonyms`) is one path. A constant (a
 * string, a number) has no identity, so two equal ones are not one value.
 *
 * ```ts
 * duplicatePaths([{ subpath: "./router", module: { UrlState, UrlStateConflict } }], [], []);
 * // [["./router UrlState.UrlStateConflict", "./router UrlStateConflict"]]
 * ```
 */
export const duplicatePaths = (
  loaded: ReadonlyArray<Loaded>,
  aliases: ReadonlyArray<Alias>,
  synonyms: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const declared = new Set(synonyms.map((set) => set.toSorted().join("\n")));
  const modules = new Map(loaded.map((one) => [one.subpath, one.module]));
  const paths = new Map<object, ReadonlyArray<string>>();
  // oxlint-disable-next-line effect/noObjectParameters -- an exported value is keyed by identity, whatever its shape.
  const place = (value: object, path: string): void => {
    const before = Option.getOrElse(Option.fromNullishOr(paths.get(value)), () => []);
    paths.set(value, [...before, path]);
  };
  for (const { subpath, module } of loaded) {
    const inherited = new Set(
      aliases
        .filter(([superset]) => superset === subpath)
        .flatMap(([, subset]) =>
          Option.match(Option.fromNullishOr(modules.get(subset)), {
            onNone: () => [],
            onSome: Object.keys,
          }),
        ),
    );
    for (const [name, value] of valuesOf(module)) {
      if (inherited.has(name)) {
        continue;
      }
      place(value, `${subpath} ${name}`);
      if (Object.prototype.toString.call(value) === namespaceTag) {
        for (const [member, inner] of valuesOf(value)) {
          place(inner, `${subpath} ${name}.${member}`);
        }
      }
    }
  }
  return Array.from(paths.values())
    .map((found) => found.toSorted())
    .filter((found) => found.length > 1 && !declared.has(found.join("\n")));
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
      (module): Surface & Loaded => ({
        subpath: subpath.key,
        names: Object.keys(module),
        module,
      }),
    ),
  );
  return { name, surfaces };
});
