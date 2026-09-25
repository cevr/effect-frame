import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { deadCitations, typeFieldsOf, typeExportsOf, type Facts } from "../src/citations";

/**
 * The citation rule: a backticked `Head.member`, or one in a ts fence,
 * whose head is an effect-frame name names something the package has. In a
 * changeset an unknown head fails too, unless it is someone else's name or
 * a `<!-- removed: … -->` marker lists it. The repository's own JSDoc,
 * reference docs and changesets are checked by `bun run declarations`.
 */

const facts: Facts = {
  values: new Map<string, ReadonlyArray<object>>([
    ["Actor", [{ local: 1, remote: 2 }]],
    ["QueryCache", [{ layer: 1 }]],
    ["Anonymous", [Object.create({ make: 1 })]],
    ["Match", [() => 1]],
  ]),
  types: new Map([
    ["QueryCache", Option.some(new Set(["read"]))],
    ["RefOptions", Option.some(new Set(["resume", "behavior"]))],
    ["Open", Option.none()],
  ]),
  effect: new Map<string, object>([["Match", { tagsExhaustive: 1 }]]),
  effectModules: new Set(["Match", "Schema", "HttpRouter"]),
  declared: new Set(["FormRoute"]),
  spans: new Set(["Prerender.build"]),
};

const jsdoc = (line: string) => ["/**", ` * ${line}`, " */", "export const x = 1;"].join("\n");

const changeset = (body: ReadonlyArray<string>) =>
  ["---", '"effect-frame": minor', "---", "", ...body].join("\n");

describe("citation rule", () => {
  it.effect("refuses a JSDoc citation of a member the head does not have", () =>
    Effect.sync(() => {
      expect(deadCitations("jsdoc", jsdoc("Start one with `Actor.spawn`."), facts)).toEqual([
        { line: 2, citation: "Actor.spawn" },
      ]);
      expect(deadCitations("jsdoc", jsdoc("Start one with `Actor.local`."), facts)).toEqual([]);
    }),
  );

  it.effect("resolves inherited statics, interface fields, open types and Effect's modules", () =>
    Effect.sync(() => {
      const cited = [
        "`Anonymous.make`, `RefOptions.behavior`, `QueryCache.read`, `QueryCache.layer`,",
        "`Open.anything`, `Match.tagsExhaustive`, and `Schema.Struct`.",
      ].join(" ");
      expect(deadCitations("jsdoc", jsdoc(cited), facts)).toEqual([]);
      expect(deadCitations("jsdoc", jsdoc("`RefOptions.behaviour`"), facts)).toEqual([
        { line: 2, citation: "RefOptions.behaviour" },
      ]);
    }),
  );

  it.effect("reads ts fences and inline code in a doc, and only JSDoc in a source", () =>
    Effect.sync(() => {
      const doc = [
        "Use `QueryCache.layerTest`.",
        "",
        "```ts",
        "const cache = QueryCache.layerTest;",
        "const fine = Actor.local;",
        "```",
        "",
        "```sh",
        "Actor.nothing",
        "```",
      ].join("\n");
      expect(deadCitations("doc", doc, facts)).toEqual([
        { line: 1, citation: "QueryCache.layerTest" },
        { line: 4, citation: "QueryCache.layerTest" },
      ]);
      const source = ["// `Actor.spawn` in a line comment", "export const a = Actor.spawn;"].join(
        "\n",
      );
      expect(deadCitations("jsdoc", source, facts)).toEqual([]);
    }),
  );

  it.effect("in a changeset, refuses an unknown head unless it is foreign or marked removed", () =>
    Effect.sync(() => {
      const stale = changeset([
        "Read with `Query.batched`; `QueryCache.layerTest` is gone.",
        "Kept: `HttpRouter.toWebHandler`, `FormRoute.render`, `Prerender.build`, `README.md`.",
      ]);
      expect(deadCitations("changeset", stale, facts)).toEqual([
        { line: 5, citation: "Query.batched" },
        { line: 5, citation: "QueryCache.layerTest" },
      ]);
      const marked = changeset([
        "<!-- removed: Query, QueryCache.layerTest -->",
        "Read with `Query.batched`; `QueryCache.layerTest` is gone.",
      ]);
      expect(deadCitations("changeset", marked, facts)).toEqual([]);
      expect(deadCitations("doc", "Read with `Query.batched`.", facts)).toEqual([]);
    }),
  );

  it.effect("reads an interface's fields, and an interface that extends as open", () =>
    Effect.sync(() => {
      const source = [
        "export interface RefOptions<C> {",
        "  readonly resume: Option<C>;",
        "  readonly behavior?: (state: {",
        "    readonly nested: number;",
        "  }) => void;",
        "  read(key: string): void;",
        "}",
        "interface Wide extends RefOptions<number> {",
        "  readonly more: 1;",
        "}",
        "export type Shape = { readonly a: 1; readonly b: 2 };",
        "export type Either = A | B;",
        "export {",
        "  type Narrow,",
        "} from './wide.js';",
      ].join("\n");
      const fields = typeFieldsOf([source]);
      expect(fields.get("RefOptions")).toEqual(
        Option.some(new Set(["resume", "behavior", "read"])),
      );
      expect(fields.get("Wide")).toEqual(Option.none());
      expect(fields.get("Shape")).toEqual(Option.some(new Set(["a", "b"])));
      expect(fields.get("Either")).toEqual(Option.none());
      expect(fields.has("Narrow")).toBe(false);
    }),
  );

  it.effect("reads the names a module exports, as types and values", () =>
    Effect.sync(() => {
      const names = typeExportsOf(
        [
          "export interface PropsOf<S> {}",
          "export type { Child, Node as Element } from './node.js';",
          "export const leaf = 1;",
          "export declare function segment(): void;",
        ].join("\n"),
      );
      expect(names).toEqual(new Set(["PropsOf", "Child", "Element", "leaf", "segment"]));
    }),
  );
});
