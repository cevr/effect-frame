import { Effect, Exit, Layer, Match, Option, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  Behavior,
  CommandId,
  implement,
  implementTransparent,
} from "@effect-frame/actor";
import { Unauthorized, contract, ref } from "@effect-frame/actor/client";
import type { Address } from "@effect-frame/actor/client";

const CounterKey = Schema.Struct({ tenant: Schema.String, id: Schema.String });
const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
const Reset = Schema.TaggedStruct("Reset", {});
const CounterMessage = Schema.Union([Add, Reset]);
type CounterMessage = Schema.Schema.Type<typeof CounterMessage>;

const Counter = contract("Counter", {
  version: 1,
  key: CounterKey,
  snapshot: Schema.Finite,
  message: CounterMessage,
});

const counterBehavior = Behavior.reducer<number, CounterMessage>({
  initial: 0,
  reduce: (state, message) =>
    Match.type<CounterMessage>().pipe(
      Match.tagsExhaustive({
        Add: (add) => state + add.amount,
        Reset: () => 0,
      }),
    )(message),
});

const CounterLive = implementTransparent(Counter, counterBehavior);

// A contract whose snapshot hides part of the state.
const Secret = contract("Secret", {
  version: 1,
  key: Schema.String,
  snapshot: Schema.Struct({ count: Schema.Finite }),
  message: Schema.Union([Add]),
});

const SecretState = Schema.Struct({ count: Schema.Finite, token: Schema.String });

const SecretLive = implement(Secret, {
  behavior: Behavior.reducer<{ count: number; token: string }, Schema.Schema.Type<typeof Add>>({
    initial: { count: 0, token: "private" },
    reduce: (state, message) => ({ ...state, count: state.count + message.amount }),
  }),
  state: Schema.fromJsonString(SecretState),
  snapshot: (state) => ({ count: state.count }),
});

const id = Schema.decodeSync(CommandId);
const add = (amount: number): CounterMessage => ({ _tag: "Add", amount });
const alice = { tenant: "acme", id: "alice" };

const host = ActorHost.layerMemory([CounterLive, SecretLive]);
const withHost = it.scoped.layer(host);

describe("remote reference", () => {
  withHost("call applies through the transport and updates the snapshot", () =>
    Effect.gen(function* () {
      const counter = yield* ref(Counter, alice);
      expect(counter.kind).toBe("remote");
      expect(yield* counter.state.get).toBe(0);
      const applied = yield* counter.call(add(3), { commandId: id("c1"), timeout: "1 second" });
      expect(applied).toEqual({ revision: 1, state: 3 });
      expect(yield* counter.applied.get).toEqual({ revision: 1, state: 3 });
    }),
  );

  withHost("two references to one key observe the same actor", () =>
    Effect.gen(function* () {
      const first = yield* ref(Counter, alice);
      const second = yield* ref(Counter, alice);
      yield* first.call(add(2), { commandId: id("c1"), timeout: "1 second" });
      const seen = yield* Stream.runHead(Stream.filter(second.state.changes, (n) => n === 2));
      expect(seen).toEqual(Option.some(2));
      const other = yield* ref(Counter, { tenant: "acme", id: "bob" });
      expect(yield* other.state.get).toBe(0);
    }),
  );

  withHost("a retried command ID applies once across references", () =>
    Effect.gen(function* () {
      const first = yield* ref(Counter, alice);
      const second = yield* ref(Counter, alice);
      const a = yield* first.call(add(2), { commandId: id("c1"), timeout: "1 second" });
      const b = yield* second.call(add(2), { commandId: id("c1"), timeout: "1 second" });
      expect(b).toEqual(a);
      const conflict = yield* Effect.flip(second.send(add(9), { commandId: id("c1") }));
      expect(conflict._tag).toBe("CommandConflict");
    }),
  );

  withHost("a reference resumes from a held snapshot and receives only later revisions", () =>
    Effect.gen(function* () {
      const writer = yield* ref(Counter, alice);
      const held = yield* writer.call(add(1), { commandId: id("c1"), timeout: "1 second" });
      yield* writer.call(add(1), { commandId: id("c2"), timeout: "1 second" });

      const resumed = yield* ref(Counter, alice, { resume: Option.some(held) });
      const caughtUp = yield* Stream.runHead(
        Stream.filter(resumed.applied.changes, (committed) => committed.revision >= 2),
      );
      expect(caughtUp).toEqual(Option.some({ revision: 2, state: 2 }));
    }),
  );

  withHost("the snapshot hides private state", () =>
    Effect.gen(function* () {
      const secret = yield* ref(Secret, "s1");
      const applied = yield* secret.call(
        { _tag: "Add", amount: 4 },
        { commandId: id("c1"), timeout: "1 second" },
      );
      expect(applied.state).toEqual({ count: 4 });
      expect(Object.keys(applied.state)).toEqual(["count"]);
    }),
  );

  withHost("a contract version the host does not serve is a mismatch", () =>
    Effect.gen(function* () {
      const CounterV2 = contract("Counter", {
        version: 2,
        key: CounterKey,
        snapshot: Schema.Finite,
        message: CounterMessage,
      });
      const failure = yield* Effect.flip(ref(CounterV2, alice));
      expect(failure._tag).toBe("ContractMismatch");
      const Unknown = contract("Nope", {
        ...Counter,
        version: 1,
        key: CounterKey,
        snapshot: Schema.Finite,
        message: CounterMessage,
      });
      const unknown = yield* Effect.flip(ref(Unknown, alice));
      expect(unknown._tag).toBe("UnknownContract");
    }),
  );

  withHost("the host scope owns the actors", () =>
    Effect.gen(function* () {
      const life = yield* Scope.make();
      const counter = yield* ref(Counter, alice).pipe(Scope.provide(life));
      yield* counter.call(add(1), { commandId: id("c1"), timeout: "1 second" });
      yield* Scope.close(life, Exit.void);
      const again = yield* ref(Counter, alice);
      expect(yield* again.state.get).toBe(1);
    }),
  );
});

const tenantOnly = (tenant: string) =>
  Layer.succeed(ActorHost.Authorizer, {
    authorize: (address: Address) =>
      Effect.flatMap(Schema.decodeEffect(Counter.key)(address.key), (key) => {
        if (key.tenant === tenant) {
          return Effect.void;
        }
        return Effect.fail(Unauthorized.make({ contract: address.contract }));
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.fail(Unauthorized.make({ contract: address.contract })),
        ),
      ),
  });

describe("authorization", () => {
  const withAcme = it.scoped.layer(Layer.provide(host, tenantOnly("acme")));

  withAcme("the authorizer sees the key and can refuse another tenant", () =>
    Effect.gen(function* () {
      const mine = yield* ref(Counter, alice);
      expect(yield* mine.state.get).toBe(0);
      const failure = yield* Effect.flip(ref(Counter, { tenant: "other", id: "x" }));
      expect(failure._tag).toBe("Unauthorized");
    }),
  );
});
