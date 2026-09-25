// oxlint-disable effect/noGlobals -- Bun.spawnSync lists the tracked tree, Bun.file reads it and Bun.Glob lists Effect's modules: the rule checks the text a reader opens against what the package has.
import * as EffectModules from "effect";
import { Effect, Option, Predicate, Schema } from "effect";
import type { Facts } from "./citations.js";
import { typeExportsOf, typeFieldsOf } from "./citations.js";
import { resolveFrom } from "./examples.js";

/**
 * What the citation rule knows, read from the repository: the built
 * package's runtime surfaces (loaded by `readSurfaces`), the type names and
 * interface fields its source exports, the namespace aliases the repository
 * imports, Effect's modules, every exported name, and every span.
 */

/** A loaded subpath: its key in `exports`, and its module. */
export interface LoadedSubpath {
  readonly subpath: string;
  readonly module: object;
}

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    exports: Schema.Record(Schema.String, Schema.Struct({ source: Schema.String })),
  }),
);

const alias = /import\s+\*\s+as\s+([A-Z][\w$]*)\s+from\s+["']effect-frame(\/[^"']*)?["']/g;
const reExport = /export\s+\*\s+from\s+["']([^"']+)["']/g;
const namespaceReExport = /export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
const declaredName =
  /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|const|function|enum|namespace)\s+([A-Z][\w$]*)/g;
const span = /Effect\.fn\(\s*"([^"]+)"/g;
const serviceTag =
  /class\s+([A-Z][\w$]*)\s+extends\s+Context\.Service<\s*[\w$]+\s*,\s*([A-Z][\w$]*)?/g;

/** Every tracked file, relative to the repository root. */
export const trackedFiles = (root: string) =>
  Effect.sync(() =>
    Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })
      .stdout.toString()
      .split("\0")
      .filter((file) => file.length > 0),
  );

/** The texts of files, keyed by path. */
export const readTexts = (root: string, files: ReadonlyArray<string>) =>
  Effect.map(
    Effect.forEach(
      files,
      (file) =>
        Effect.map(
          Effect.promise(() => Bun.file(`${root}/${file}`).text()),
          (text): readonly [string, string] => [file, text],
        ),
      { concurrency: 16 },
    ),
    (entries): ReadonlyMap<string, string> => new Map(entries),
  );

/** A relative module specifier from a file, as the tracked `.ts` or `.tsx` it names. */
const moduleFile = (
  texts: ReadonlyMap<string, string>,
  from: string,
  specifier: string,
): Option.Option<string> => {
  const base = resolveFrom(from, specifier).replace(/\.js$/, "");
  return Option.fromNullishOr(
    [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((file) => texts.has(file)),
  );
};

/**
 * The names a module exports, following `export *`; and each namespace it
 * re-exports (`export * as View`) with that module's names.
 */
const moduleNames = (
  texts: ReadonlyMap<string, string>,
  file: string,
  seen: Set<string>,
  namespaces: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> => {
  if (seen.has(file)) {
    return new Set();
  }
  seen.add(file);
  const text = Option.getOrElse(Option.fromNullishOr(texts.get(file)), () => "");
  for (const match of text.matchAll(namespaceReExport)) {
    Option.map(moduleFile(texts, file, match[2] ?? ""), (target) =>
      namespaces.set(match[1] ?? "", moduleNames(texts, target, new Set(), namespaces)),
    );
  }
  const followed = Array.from(text.matchAll(reExport), (match) =>
    Option.toArray(moduleFile(texts, file, match[1] ?? "")),
  )
    .flat()
    .flatMap((target) => Array.from(moduleNames(texts, target, seen, namespaces)));
  return new Set([...typeExportsOf(text), ...followed]);
};

/** Both member sets as one; `None` if either is open. */
const merge = (
  a: Option.Option<Option.Option<ReadonlySet<string>>>,
  b: Option.Option<ReadonlySet<string>>,
): Option.Option<ReadonlySet<string>> =>
  Option.match(a, {
    onNone: () => b,
    onSome: (before) =>
      Option.zipWith(before, b, (x, y): ReadonlySet<string> => new Set([...x, ...y])),
  });

/** The facts the citation rule resolves against. */
export const readFacts = Effect.fn("Citations.readFacts")(function* (
  root: string,
  directory: string,
  loaded: ReadonlyArray<LoadedSubpath>,
) {
  const files = yield* trackedFiles(root);
  const texts = yield* readTexts(
    root,
    files.filter((file) => /\.(?:tsx?|md)$/.test(file)),
  );
  const manifest = yield* Effect.flatMap(
    Effect.promise(() => Bun.file(`${root}/${directory}/package.json`).text()),
    Schema.decodeEffect(Manifest),
  );
  const modules = new Map(loaded.map((one) => [one.subpath, one.module]));
  const namespaces = new Map<string, ReadonlySet<string>>();
  const exported = new Map(
    Object.entries(manifest.exports).map(([subpath, entry]) => [
      subpath,
      moduleNames(
        texts,
        `${directory}/${entry.source.replace(/^\.\//, "")}`,
        new Set(),
        namespaces,
      ),
    ]),
  );
  const values = new Map<string, Array<object>>();
  const valuesOf = (head: string): Array<object> =>
    Option.getOrElse(Option.fromNullishOr(values.get(head)), () => {
      const created: Array<object> = [];
      values.set(head, created);
      return created;
    });
  for (const one of loaded) {
    for (const [name, value] of Object.entries(one.module)) {
      if (Predicate.isObjectKeyword(value)) {
        valuesOf(name).push(value);
      }
    }
  }
  const types = new Map<string, Option.Option<ReadonlySet<string>>>();
  // An open type does not open a head that has runtime values: the value's
  // own members still decide (`Behavior.value`, `QueryCache.layer`).
  const addTypes = (head: string, found: Option.Option<ReadonlySet<string>>) => {
    if (Option.isNone(found) && values.has(head)) {
      return;
    }
    types.set(head, merge(Option.fromNullishOr(types.get(head)), found));
  };
  const sources = [...texts]
    .filter(([file]) => file.startsWith(`${directory}/src/`))
    .map(([, text]) => text);
  const fields = typeFieldsOf(sources);
  const exportedNames = new Set([...exported.values()].flatMap((names) => Array.from(names)));
  for (const name of exportedNames) {
    Option.map(Option.fromNullishOr(fields.get(name)), (found) => addTypes(name, found));
  }
  // A service tag's members are its service interface's: `Router.current` is a field of `RouterService`.
  for (const text of sources) {
    for (const match of text.matchAll(serviceTag)) {
      const tag = match[1] ?? "";
      if (exportedNames.has(tag)) {
        const service = Option.flatten(Option.fromNullishOr(fields.get(match[2] ?? "")));
        addTypes(tag, service);
      }
    }
  }
  for (const [name, members] of namespaces) {
    addTypes(name, Option.some(members));
  }
  for (const text of texts.values()) {
    for (const match of text.matchAll(alias)) {
      const subpath = `.${match[2] ?? ""}`;
      Option.map(Option.fromNullishOr(modules.get(subpath)), (module) =>
        valuesOf(match[1] ?? "").push(module),
      );
      Option.map(Option.fromNullishOr(exported.get(subpath)), (names) =>
        addTypes(match[1] ?? "", Option.some(names)),
      );
    }
  }
  const effectFiles = Array.from(
    new Bun.Glob("**/*.ts").scanSync({ cwd: `${root}/node_modules/effect/src` }),
  );
  const code = [...texts].filter(([file]) => /\.tsx?$/.test(file)).map(([, text]) => text);
  const facts: Facts = {
    values,
    types,
    effect: new Map(
      Object.entries(EffectModules).filter((entry): entry is [string, object] =>
        Predicate.isObjectKeyword(entry[1]),
      ),
    ),
    effectModules: new Set(
      effectFiles
        .map((file) => Option.getOrElse(Option.fromNullishOr(file.split("/").pop()), () => ""))
        .map((file) => file.replace(/\.ts$/, ""))
        .filter((name) => /^[A-Z]/.test(name)),
    ),
    declared: new Set(
      code.flatMap((text) => Array.from(text.matchAll(declaredName), (match) => match[1] ?? "")),
    ),
    spans: new Set(
      code.flatMap((text) => Array.from(text.matchAll(span), (match) => match[1] ?? "")),
    ),
  };
  return { facts, texts };
});
