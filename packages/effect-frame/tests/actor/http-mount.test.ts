import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  Behavior,
  HttpServer,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import { contract } from "effect-frame/actor/client";
import * as Wire from "../../src/actor/http/wire.js";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("Counter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

const CounterLive = implementTransparent(Counter, {
  behavior: Behavior.reducer<number, Add>({
    initial: 0,
    reduce: (state, message) => state + message.amount,
  }),
});

const host = Layer.provide(
  ActorHost.layer({ implementations: [CounterLive], store: ActorHost.memoryStore }),
  Layer.succeed(Policies, Policies.of({ public: Policy.allowAll })),
);

const address = '{"contract":"Counter","version":1,"key":"\\"alice\\""}';
const snapshotBody = `{"address":${address}}`;

const post = (path: string, body: string) =>
  new Request(`http://host.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

/** A one-KiB limit, so a small padded body crosses it. */
const mount = HttpServer.make({
  prefix: "/actors",
  principal: HttpServer.anonymous,
  maxBodyBytes: 1024,
  form: Option.none(),
});

const withHost = it.effect.layer(host);

describe("the actor handler's mount", () => {
  withHost("answers a verb at its prefix exactly, and 404 anywhere else", () =>
    Effect.gen(function* () {
      const actors = yield* mount;
      const served = yield* actors(post(`/actors${Wire.paths.snapshot}`, snapshotBody));
      expect(served.status).toBe(200);
      const elsewhere = yield* actors(post(`/elsewhere${Wire.paths.snapshot}`, snapshotBody));
      expect(elsewhere.status).toBe(404);
      // A host that names no form route has none.
      const form = yield* actors(post(`/actors${Wire.paths.form}`, ""));
      expect(form.status).toBe(404);
    }),
  );

  withHost("answers 413 to a body over the host's limit, declared or streamed", () =>
    Effect.gen(function* () {
      const actors = yield* mount;
      const padded = `{"address":${address},"pad":"${"x".repeat(2048)}"}`;
      const declared = yield* actors(post(`/actors${Wire.paths.snapshot}`, padded));
      expect(declared.status).toBe(413);
      const streamed = new Request(`http://host.test/actors${Wire.paths.snapshot}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Blob([padded]).stream(),
      });
      expect((yield* actors(streamed)).status).toBe(413);
      const small = yield* actors(post(`/actors${Wire.paths.snapshot}`, snapshotBody));
      expect(small.status).toBe(200);
    }),
  );
});
