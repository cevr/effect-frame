import { Context, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";
import {
  Actor,
  ActorHost,
  Behavior,
  MailboxStore,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import {
  ActorTransport,
  Unreachable,
  committedRevision,
  contract,
} from "effect-frame/actor/client";
import type { TransportService } from "effect-frame/actor/client";
import type { StoreFactory } from "effect-frame/actor/testing";
import * as StorageStore from "../src/storage-store.js";
import { scopedFake } from "./sqlite-storage.js";

/**
 * #29: a command whose replies were all lost stays Uncertain once the #19
 * bound of eight passes is spent, and only the same ID sent again settles
 * it. That works only if the store still holds the receipt after the bound,
 * so the claim is run over both stores the gate builds.
 */

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("BoundCounter", {
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

const policies = Policies.of({ public: Policy.allowAll });

const memory: StoreFactory = Effect.map(Layer.build(MailboxStore.layerMemory), (built) =>
  Context.get(built, MailboxStore),
);

const storage: StoreFactory = Effect.flatMap(scopedFake, StorageStore.make);

const stores: ReadonlyArray<readonly [string, StoreFactory]> = [
  ["memory", memory],
  ["durable-object storage over bun:sqlite", storage],
];

describe("a receipt outlives the retry bound", () => {
  for (const [name, factory] of stores) {
    it.scoped(`${name}: an exhausted Uncertain command settles from its stored receipt`, () =>
      Effect.gen(function* () {
        const store = yield* factory;
        const real = yield* ActorHost.make({
          implementations: [CounterLive],
          store: () => Layer.succeed(MailboxStore, store),
        }).pipe(Effect.provideService(Policies, policies));
        // Every call reaches the host and commits; only its reply is lost.
        const lose = { replies: true };
        const wire: TransportService = {
          ...real,
          call: (address, commandId, payload, timeout, active) =>
            Effect.suspend(() => {
              if (!lose.replies) {
                return real.call(address, commandId, payload, timeout, active);
              }
              return Effect.andThen(
                Effect.exit(real.call(address, commandId, payload, timeout, active)),
                Effect.fail(Unreachable.make({ reason: "reply lost" })),
              );
            }),
        };
        const counter = yield* Actor.remote(Counter, "alice").pipe(
          Effect.provideService(ActorTransport, wire),
        );

        const handle = yield* counter.send({ _tag: "Add", amount: 5 });
        yield* TestClock.adjust("5 minutes");
        expect(yield* handle.state.get).toEqual({
          _tag: "Uncertain",
          attempt: 8,
          admitted: Option.some(1),
        });
        // Long after the bound, the store still holds the receipt.
        yield* TestClock.adjust("1 hour");
        const kept = yield* store.receipt(handle.commandId);
        expect(Option.map(kept, (receipt) => [receipt.admitted, receipt.revision])).toEqual(
          Option.some([1, 1]),
        );

        lose.replies = false;
        yield* handle.retry;
        expect(yield* handle.settled).toEqual({
          _tag: "Applied",
          admitted: 1,
          revision: committedRevision(1),
          state: 5,
        });
        // Nine sequences of re-sends applied the command once.
        expect(Option.map(yield* store.latest, (latest) => latest.revision)).toEqual(
          Option.some(1),
        );
      }),
    );
  }
});
