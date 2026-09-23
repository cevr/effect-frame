import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scope } from "effect";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { Node } from "../scripts/proof.js";
import { freePort, prepare } from "../scripts/proof.js";
import { workerd } from "../scripts/workerd-process.js";

/**
 * The storage store inside a real SQLite-backed Durable Object.
 *
 * The bun:sqlite fake in `storage-store.test.ts` proves the store's logic.
 * It cannot prove what the store assumes of the runtime: the shape of the
 * transaction handle, that an async transaction commits and rolls back as a
 * unit, and that an alarm set inside one lands at commit. This test serves
 * `fixture-conformance` with workerd, the runtime Alchemy runs locally, and
 * asks one object to run the suites against its own storage.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const fixtureDir = join(packageRoot, "fixture-conformance");
const proofDir = join(packageRoot, "..", "..", ".proof", "workerd-conformance");

const Cases = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({ name: Schema.String, passed: Schema.Boolean, detail: Schema.String }),
  ),
});
const decodeCases = Schema.decodeUnknownEffect(Cases);

/** Builds the fixture worker the way the proofs do, into the fixture directory. */
const build = Effect.promise(() =>
  Bun.build({
    entrypoints: [join(fixtureDir, "index.ts")],
    outdir: fixtureDir,
    naming: "worker.js",
    target: "browser",
    format: "esm",
    conditions: ["source"],
  }),
);

/** workerd over a fresh copy of the fixture, stopped when the scope closes. */
const serve: Effect.Effect<Node, never, Scope.Scope> = Effect.acquireRelease(
  Effect.gen(function* () {
    yield* Effect.sync(() => prepare(fixtureDir, proofDir));
    const port = yield* Effect.promise(freePort);
    return yield* Effect.promise(() => workerd.start(proofDir, port));
  }),
  (node) => Effect.promise(() => node.stop()),
);

const run = (node: Node, suite: string) =>
  Effect.flatMap(
    Effect.promise(() =>
      fetch(`http://127.0.0.1:${node.port}/${suite}?object=${suite}-${Date.now()}`).then(
        (response) => response.json(),
      ),
    ),
    (body) => Effect.orDie(decodeCases(body)),
  );

const failures = (cases: Schema.Schema.Type<typeof Cases>["cases"]): ReadonlyArray<string> =>
  cases.filter((found) => !found.passed).map((found) => `${found.name} — ${found.detail}`);

describe("the storage store on workerd", () => {
  it.scopedLive(
    "the runtime keeps the store's transaction and alarm assumptions",
    () =>
      Effect.gen(function* () {
        const built = yield* build;
        expect(built.success).toBe(true);
        const node = yield* serve;
        const result = yield* run(node, "assumptions");
        expect(failures(result.cases)).toEqual([]);
        expect(result.cases.length).toBe(5);
      }),
    30_000,
  );

  it.scopedLive(
    "MailboxStore conformance passes inside a SQLite-backed Durable Object",
    () =>
      Effect.gen(function* () {
        const built = yield* build;
        expect(built.success).toBe(true);
        const node = yield* serve;
        const result = yield* run(node, "conformance");
        expect(failures(result.cases)).toEqual([]);
        expect(result.cases.length).toBeGreaterThan(6);
      }),
    30_000,
  );
});
