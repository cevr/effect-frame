import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Authenticated,
  CurrentPrincipal,
  Policies,
  Policy,
  QueryCache,
  Streaming,
  implementQuery,
  query,
} from "effect-frame/actor";
import type { QueryFailure, QueryState } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Html, View } from "effect-frame/view";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  Label,
  collect,
  frame,
  idOf,
  makeControl,
  noLimit,
  recordsIn,
  sideOf,
  valueRecord,
} from "./streaming-fixture.js";

/**
 * A streamed document and the principal (#22 with #85). A server render
 * reads its queries under the principal its caller provides, through the
 * same policy check as every other read. The client stamps each seed with
 * its own principal generation, and drops a seed it has not used when that
 * generation moves.
 */

const Secret = query("StreamSecret", {
  version: 1,
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ label: Schema.String }),
  policy: "member",
  depends: [],
});

const secretLabel = "classified-label";

/** A host whose one query only a signed-in caller may read. */
const guarded = Layer.build(
  QueryTest.layer({
    queries: [implementQuery(Secret, { run: () => Effect.succeed({ label: secretLabel }) })],
  }).pipe(
    Layer.provide(Layer.succeed(Policies, Policies.of({ member: Policy.authenticated }))),
    Layer.orDie,
  ),
);

const labelOf = (state: QueryState<{ readonly label: string }, QueryFailure>): string => {
  if (state._tag === "Ready") {
    return state.value.label;
  }
  return state._tag;
};

const SecretPage = () =>
  Effect.gen(function* () {
    const scope = yield* View.loading({
      fallback: <p id="pending">loading</p>,
      content: Effect.gen(function* () {
        const entry = yield* QueryCache.use((cache) => cache.open(Secret, { id: "a" }));
        return <p id="secret">{View.bind(entry.state, labelOf)}</p>;
      }),
    });
    return <section>{scope}</section>;
  });

const secretId = Streaming.recordId({
  query: Secret.name,
  version: Secret.version,
  args: Schema.encodeSync(Secret.args)({ id: "a" }),
});

/** The value a signed-in render writes, encoded as the wire carries it. */
const secretJson = Schema.encodeSync(Secret.result)({ label: secretLabel });

const alice = Authenticated.make({ subject: "alice", claims: {} });

/** Each patch in a document as one line: its id, its outcome, and a failure's tag. */
const outcomeOf = (record: Streaming.StreamRecord): ReadonlyArray<string> => {
  if (record._tag !== "Patch") {
    return [];
  }
  if (record.outcome._tag === "Error") {
    return [`${record.id} Error ${record.outcome.error._tag}`];
  }
  return [`${record.id} Value ${record.outcome.value}`];
};

describe("a server render reads under the request's principal", () => {
  it.scoped("an anonymous render of a protected query writes the refusal, never the value", () =>
    Effect.gen(function* () {
      const server = yield* guarded;
      const html = (yield* collect(
        Html.renderToStream(SecretPage, {}, frame, noLimit).pipe(Stream.provideContext(server)),
      )).join("");

      expect(recordsIn(html).flatMap(outcomeOf)).toEqual([`${secretId} Error Unauthorized`]);
      expect(html).not.toContain(secretLabel);
    }),
  );

  it.scoped("the same render under a signed-in principal writes the value", () =>
    Effect.gen(function* () {
      const server = yield* guarded;
      const html = (yield* collect(
        Html.renderToStream(SecretPage, {}, frame, noLimit).pipe(
          Stream.provideContext(server),
          Stream.provideService(CurrentPrincipal, alice),
        ),
      )).join("");

      expect(recordsIn(html).flatMap(outcomeOf)).toEqual([`${secretId} Value ${secretJson}`]);
    }),
  );
});

describe("a seed and the client's principal", () => {
  it.scopedLive("a seed no view took yet does not survive a principal change", () =>
    Effect.gen(function* () {
      const control = makeControl({ a: "fresh" });
      const client = yield* sideOf(control);
      const seen = yield* Effect.gen(function* () {
        // The document was read for the principal of its request.
        yield* Streaming.resume({
          present: [valueRecord(idOf("a"), "seeded")],
          later: Stream.empty,
        });
        // The client learns its principal changed before any view declared the key.
        const cache = yield* QueryCache;
        yield* cache.principalChanged;
        const entry = yield* cache.open(Label, { id: "a" });
        const first = yield* entry.state.get;
        const landed = yield* Effect.timeoutOption(
          Stream.runHead(Stream.filter(entry.state.changes, (state) => state._tag === "Ready")),
          "3 seconds",
        );
        return { first, landed: Option.flatten(landed) };
      }).pipe(Effect.provideContext(client));

      // The key reads for the new principal instead of showing the seed.
      expect(seen.first._tag).toBe("Loading");
      expect(Option.map(seen.landed, (state) => labelOf(state))).toEqual(Option.some("fresh"));
      expect(control.calls).toEqual(["a"]);
    }),
  );
});
