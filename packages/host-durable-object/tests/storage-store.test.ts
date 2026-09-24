import { Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";
import { CommandId } from "effect-frame/actor";
import { mailboxStoreConformance } from "effect-frame/actor/testing";
import * as Interop from "../src/interop.js";
import * as StorageStore from "../src/storage-store.js";
import { scopedFake } from "./sqlite-storage.js";

const id = Schema.decodeSync(CommandId);

/** A fresh SQLite-backed store for each conformance case. */
const factory = Effect.flatMap(scopedFake, StorageStore.make);

describe("MailboxStore conformance: durable-object storage over bun:sqlite", () => {
  it.effect("every case passes", () =>
    Effect.gen(function* () {
      const cases = yield* mailboxStoreConformance(factory);
      const failed = cases.filter((result) => !result.passed);
      expect(failed.map((result) => `${result.name} — ${result.detail}`)).toEqual([]);
      expect(cases.length).toBeGreaterThan(6);
    }),
  );
});

describe("storage store recovery obligations", () => {
  it.scoped("append arms an alarm inside the admission transaction", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const store = yield* StorageStore.make(storage);
      expect(Option.isNone(storage.armed())).toBe(true);
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
      // The alarm published at commit, not before the insert.
      expect(storage.armed()).toEqual(Option.some(now));
      const read = yield* Interop.getAlarm(storage);
      expect(read).toEqual(Option.some(now));
    }),
  );

  it.scoped("a reopened store over the same storage sees the pending command", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const first = yield* StorageStore.make(storage);
      yield* first.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
      yield* first.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
      yield* first.commit(id("a"), "s1", Option.none());

      // A restart builds a new store over the storage that survived.
      const second = yield* StorageStore.make(storage);
      expect(yield* second.pending).toEqual([id("b")]);
      expect(yield* second.latest).toEqual(
        Option.some({ revision: 1, state: "s1", wake: Option.none() }),
      );
      const receipt = yield* second.receipt(id("a"));
      expect(Option.map(receipt, (found) => found.revision)).toEqual(Option.some(1));
    }),
  );

  it.scoped("a commit arms the committed state's wake in the same transaction", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const store = yield* StorageStore.make(storage);
      yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
      yield* store.commit(id("a"), "s1", Option.some(90_000));
      expect(storage.armed()).toEqual(Option.some(90_000));
      yield* store.advance("s2", Option.some(120_000));
      expect(storage.armed()).toEqual(Option.some(120_000));
    }),
  );

  it.scoped("a wake already due arms the alarm at now, never in the past", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const store = yield* StorageStore.make(storage);
      yield* TestClock.adjust("5 seconds");
      // workerd refuses a past alarm inside the transaction, and the commit
      // with it: work in flight names a wake of 0.
      yield* store.advance("running", Option.some(0));
      expect(storage.armed()).toEqual(Option.some(5_000));
      expect(Option.map(yield* store.latest, (latest) => latest.wake)).toEqual(
        Option.some(Option.some(0)),
      );
    }),
  );

  it.scoped("a commit with a command still pending keeps the object waking now", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const store = yield* StorageStore.make(storage);
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
      yield* store.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
      // A later deadline must not push back the drain of "b".
      yield* store.commit(id("a"), "s1", Option.some(90_000));
      expect(storage.armed()).toEqual(Option.some(now));
      yield* store.commit(id("b"), "s2", Option.some(90_000));
      expect(storage.armed()).toEqual(Option.some(90_000));
    }),
  );

  it.scoped("an object written before the wake column gains it and reads no wake", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      storage.sql.exec(`CREATE TABLE committed (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER, state TEXT)`);
      storage.sql.exec("INSERT INTO committed (id, revision, state) VALUES (1, 4, 's4')");
      const store = yield* StorageStore.make(storage);
      expect(yield* store.latest).toEqual(
        Option.some({ revision: 4, state: "s4", wake: Option.none() }),
      );
      yield* store.advance("s5", Option.some(1_000));
      expect(Option.map(yield* store.latest, (latest) => latest.wake)).toEqual(
        Option.some(Option.some(1_000)),
      );
    }),
  );

  it.scoped("a failed commit transaction leaves no partial state", () =>
    Effect.gen(function* () {
      const storage = yield* scopedFake;
      const store = yield* StorageStore.make(storage);
      yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
      const broken = yield* Effect.exit(
        Effect.promise(() =>
          storage.transaction(async () => {
            storage.sql.exec(
              "UPDATE commands SET revision = 1, state = 'half' WHERE command_id = ?",
              "a",
            );
            return await Promise.reject({ _tag: "DeliberateRollback" });
          }),
        ),
      );
      expect(broken._tag).toBe("Failure");
      expect(yield* store.pending).toEqual([id("a")]);
      expect(yield* store.latest).toEqual(Option.none());
      expect(yield* store.receipt(id("a"))).toEqual(Option.none());
    }),
  );
});
