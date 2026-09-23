import { Context, Effect, Hash, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  Behavior,
  CommandId,
  HttpServer,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import type { Principal as PrincipalValue } from "effect-frame/actor/client";
import { Anonymous, Authenticated, Principal, contract } from "effect-frame/actor/client";
import { defineFrameHost } from "../src/frame-host.js";
import * as StorageStore from "../src/storage-store.js";
import { scopedFake } from "./sqlite-storage.js";

/**
 * The generic Durable Object class over the SQLite fake. No celld node runs
 * here: the class only needs storage, so a fake proves the wire, the address
 * row, and the alarm path. `scripts/contract-proof.ts` proves the same class
 * against the real binary across a SIGKILL.
 */

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("Counter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

const CounterLive = implementTransparent(
  Counter,
  Behavior.reducer<number, Add>({ initial: 0, reduce: (state, message) => state + message.amount }),
);

const FrameHost = defineFrameHost({
  implementations: [CounterLive],
  layer: Layer.succeed(Policies, Policies.of({ public: Policy.allowAll })),
  principal: HttpServer.anonymous,
  pollInterval: Option.some("5 millis"),
});

const address = { contract: "Counter", version: 1, key: JSON.stringify("alice") };

const id = Schema.decodeSync(CommandId);

const post = (
  path: string,
  body: unknown,
  member: Option.Option<string> = Option.none(),
): Request => {
  const headers = new Headers({ "content-type": "application/json" });
  Option.map(member, (name) => headers.set("x-member", name));
  return new Request(`http://host.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

// A protected contract: only a member may read or send. The celld alarm
// has no member to present, so it must recover without the public wire.
const Guarded = contract("Guarded", {
  version: 1,
  policy: "members",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

const GuardedLive = implementTransparent(
  Guarded,
  Behavior.reducer<number, Add>({ initial: 0, reduce: (state, message) => state + message.amount }),
);

/** The members this object admits. Only the object's own layer provides it. */
class Members extends Context.Service<Members, ReadonlySet<string>>()(
  "@effect-frame/host-durable-object/tests/frame-host.test/Members",
) {}

/**
 * Who is asking: a member the header names. Anyone else is anonymous. The
 * derivation reads `Members`, so the object's runtime must supply it.
 */
const memberPrincipal: HttpServer.DerivePrincipal<Members> = (request) =>
  Effect.gen(function* () {
    const members = yield* Members;
    return Principal.constant(
      Option.match(
        Option.filter(Option.fromNullishOr(request.headers.get("x-member")), (name) =>
          members.has(name),
        ),
        {
          onNone: (): PrincipalValue => Anonymous.make({}),
          onSome: (subject) => Authenticated.make({ subject, claims: {} }),
        },
      ),
    );
  });

const GuardedHost = defineFrameHost({
  implementations: [GuardedLive],
  layer: Layer.mergeAll(
    Layer.succeed(Policies, Policies.of({ members: Policy.authenticated })),
    Layer.succeed(Members, new Set(["alice"])),
  ),
  principal: memberPrincipal,
  pollInterval: Option.some("5 millis"),
});

const guardedAddress = { contract: "Guarded", version: 1, key: JSON.stringify("vault") };

/** The JSON a wire reply carries. The test reads the two fields it asserts. */
const WireBody = Schema.Struct({ revision: Schema.Finite, snapshot: Schema.String });
const decodeWire = Schema.decodeUnknownEffect(Schema.fromJsonString(WireBody));

const read = Effect.fn("frameHost.read")(function* (response: Response) {
  const text = yield* Effect.promise(() => response.text());
  return yield* Effect.orDie(decodeWire(text));
});

describe("the generic frame host over durable-object storage", () => {
  it.scoped("snapshot and call cross the generic wire", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const host = new FrameHost({ storage }, {});

      const empty = yield* read(
        yield* Effect.promise(() => host.fetch(post("/snapshot", { address }))),
      );
      expect(empty).toEqual({ revision: 0, snapshot: "0" });

      const applied = yield* read(
        yield* Effect.promise(() =>
          host.fetch(
            post("/call", {
              address,
              commandId: "c1",
              payload: JSON.stringify({ _tag: "Add", amount: 3 }),
              timeoutMillis: 2000,
            }),
          ),
        ),
      );
      expect(applied).toEqual({ revision: 1, snapshot: "3" });
    }),
  );

  it.scoped("the first request records the address the alarm needs", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const host = new FrameHost({ storage }, {});
      // An alarm before any request has no address to open, and does nothing.
      yield* Effect.promise(() => host.alarm());
      expect(
        storage.sql.exec("SELECT contract FROM hosted_address WHERE id = 1").toArray(),
      ).toEqual([]);

      yield* Effect.promise(() => host.fetch(post("/snapshot", { address })));
      expect(
        storage.sql.exec("SELECT contract, version, key FROM hosted_address").toArray(),
      ).toEqual([{ contract: "Counter", version: 1, key: address.key }]);
    }),
  );

  it.scoped("a restart drains a command admitted before it, on the alarm alone", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      // What an admission before a crash leaves behind: the address row and
      // one pending command. The object that wrote them is gone, so only the
      // new object's alarm can drain the mailbox. Seeding the rows is how a
      // one-process test stands in for a lost process; a live first object
      // would keep draining over the shared fake storage and prove nothing.
      const host = new FrameHost({ storage }, {});
      const store = yield* StorageStore.make(storage);
      const payload = JSON.stringify({ _tag: "Add", amount: 7 });
      yield* store.append({ commandId: id("c1"), payload, payloadHash: Hash.string(payload) });
      storage.sql.exec(
        "INSERT INTO hosted_address (id, contract, version, key) VALUES (1, ?, ?, ?)",
        address.contract,
        address.version,
        address.key,
      );

      yield* Effect.promise(() => host.alarm());

      const settled = yield* read(
        yield* Effect.promise(() => host.fetch(post("/snapshot", { address }))),
      );
      expect(settled).toEqual({ revision: 1, snapshot: "7" });
      expect(
        storage.sql.exec("SELECT command_id FROM commands WHERE revision IS NULL").toArray(),
      ).toEqual([]);
    }),
  );

  it.scoped("a restart drains a protected actor's admitted command on the alarm alone", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      // The alarm has no caller. A protected actor must still recover: the
      // wake opens the instance inside the host, not through the public wire.
      const host = new GuardedHost({ storage }, {});
      const store = yield* StorageStore.make(storage);
      const payload = JSON.stringify({ _tag: "Add", amount: 5 });
      yield* store.append({ commandId: id("g1"), payload, payloadHash: Hash.string(payload) });
      storage.sql.exec(
        "INSERT INTO hosted_address (id, contract, version, key) VALUES (1, ?, ?, ?)",
        guardedAddress.contract,
        guardedAddress.version,
        guardedAddress.key,
      );

      yield* Effect.promise(() => host.alarm());

      expect(
        storage.sql.exec("SELECT command_id FROM commands WHERE revision IS NULL").toArray(),
      ).toEqual([]);
      // Public reads stay under the policy: a member reads, a stranger is refused.
      const member = yield* read(
        yield* Effect.promise(() =>
          host.fetch(post("/snapshot", { address: guardedAddress }, Option.some("alice"))),
        ),
      );
      expect(member).toEqual({ revision: 1, snapshot: "5" });
      const stranger = yield* Effect.promise(() =>
        host.fetch(post("/snapshot", { address: guardedAddress }, Option.none())),
      );
      expect(stranger.status).toBe(403);
    }),
  );
});
