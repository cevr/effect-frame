// oxlint-disable effect/noGlobals -- the test is a browser: it fetches from a real server.
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { inProcess } from "../src/host.server.js";
import { memberHeader, serve } from "../src/server.js";

/**
 * #22 over the wire: the overview from a real Bun server on a free port,
 * read chunk by chunk as a browser receives it. The first chunk carries the
 * one route actor as an `ActorSeed` and a `Placeholder` for each of the
 * five query keys; each key's `Patch` follows its placeholder; `Closed` is
 * last and names all five. Since 0.21.0 a route actor travels as an
 * `ActorSeed` record, not a placeholder: it is settled before its view
 * draws, so there is nothing to patch later.
 */

const Record = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.String,
    id: Schema.optionalKey(Schema.String),
    patched: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const decodeRecord = Schema.decodeUnknownSync(Record);

const recordPattern = /<script type="application\/json" class="frame-record">(.*?)<\/script>/g;

/** The records one chunk carries, in document order. */
const recordsIn = (chunk: string) =>
  Array.from(chunk.matchAll(recordPattern), (match) => decodeRecord(match[1] ?? ""));

/** A record as the tests name it: `Patch Revenue`. */
const labelOf = (record: ReturnType<typeof decodeRecord>): string => {
  const id = Option.getOrElse(Option.fromNullishOr(record.id), () => "");
  // `Revenue@1/{…}` for a query, `actor:Alerts@1/{…}` for an actor.
  const name = id.slice(0, id.indexOf("@")).replace(/^actor:/, "");
  return `${record._tag} ${name}`.trim();
};

const queries = ["TenantInfo", "Revenue", "Orders", "Funnel", "Slowest"];

/** The body of one response, as the chunks the socket delivered. */
const chunksOf = (response: Response) =>
  Stream.fromReadableStream({
    evaluate: () => Option.getOrThrow(Option.fromNullishOr(response.body)),
    onError: (error) => error,
  }).pipe(Stream.decodeText, Stream.runCollect, Effect.orDie);

describe("the overview's streamed document on a real server (#22)", () => {
  it.scopedLive(
    "five placeholders precede five patches; one actor seed is in the first chunk",
    () =>
      Effect.gen(function* () {
        const host = yield* Layer.build(inProcess);
        // Port 0: the system picks a free one.
        const server = yield* Effect.provideContext(
          serve({ port: 0, member: Option.none() }),
          host,
        );
        const response = yield* Effect.promise(() =>
          fetch(`${server.url}/d/acme`, { headers: { [memberHeader]: "acme" } }),
        );
        expect(response.status).toBe(200);
        const chunks = yield* chunksOf(response);

        // The first chunk: the shell, the actor's seed, and every placeholder.
        const first = recordsIn(chunks[0] ?? "").map(labelOf);
        expect(first.slice(0, 6)).toEqual([
          "ActorSeed Alerts",
          ...queries.map((name) => `Placeholder ${name}`),
        ]);

        // Across the document: each key's patch after its placeholder, once.
        const records = Array.from(chunks).flatMap(recordsIn);
        const labels = records.map(labelOf);
        for (const name of queries) {
          const placed = labels.indexOf(`Placeholder ${name}`);
          const patched = labels.indexOf(`Patch ${name}`);
          expect({ name, placed: placed >= 0, before: placed < patched }).toEqual({
            name,
            placed: true,
            before: true,
          });
          expect(labels.filter((label) => label === `Patch ${name}`)).toHaveLength(1);
        }
        expect(labels.filter((label) => label.startsWith("Placeholder"))).toHaveLength(5);
        expect(labels.filter((label) => label.startsWith("ActorSeed"))).toHaveLength(1);

        // Closed: exactly one, last, and it names all five keys.
        expect(labels.filter((label) => label === "Closed")).toHaveLength(1);
        const closed = records[records.length - 1];
        expect(closed?._tag).toBe("Closed");
        const named = (closed?.patched ?? []).map((id) => id.slice(0, id.indexOf("@")));
        expect(named.toSorted()).toEqual(queries.toSorted());
      }),
  );
});
