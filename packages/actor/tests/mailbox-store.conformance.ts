import type { Layer } from "effect";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { CommandId, MailboxStore } from "@effect-frame/actor";

const id = Schema.decodeSync(CommandId);

/**
 * The conformance suite every `MailboxStore` implementation must pass.
 * The layer must supply a fresh, empty store for each test.
 */
export const mailboxStoreConformance = (name: string, layer: Layer.Layer<MailboxStore>) => {
  const test = it.scoped.layer(layer);

  describe(`MailboxStore conformance: ${name}`, () => {
    test("starts empty", () =>
      Effect.gen(function* () {
        const store = yield* MailboxStore;
        expect(yield* store.next).toEqual(Option.none());
        expect(yield* store.pending).toEqual([]);
        expect(yield* store.latest).toEqual(Option.none());
      }));

    test("append admits in order and next returns the oldest uncommitted command", () =>
      Effect.gen(function* () {
        const store = yield* MailboxStore;
        const first = yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
        const second = yield* store.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
        expect(first).toEqual({ _tag: "Admitted", admitted: 1 });
        expect(second).toEqual({ _tag: "Admitted", admitted: 2 });
        const next = yield* store.next;
        expect(Option.map(next, (command) => command.commandId)).toEqual(Option.some(id("a")));
        expect(yield* store.pending).toEqual([id("a"), id("b")]);
      }));

    test("append with the same ID and hash is a duplicate that carries the receipt", () =>
      Effect.gen(function* () {
        const store = yield* MailboxStore;
        yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
        const beforeCommit = yield* store.append({
          commandId: id("a"),
          payload: "1",
          payloadHash: 1,
        });
        expect(beforeCommit).toEqual({ _tag: "Duplicate", admitted: 1, receipt: Option.none() });
        const receipt = yield* store.commit(id("a"), "s1");
        const afterCommit = yield* store.append({
          commandId: id("a"),
          payload: "1",
          payloadHash: 1,
        });
        expect(afterCommit).toEqual({
          _tag: "Duplicate",
          admitted: 1,
          receipt: Option.some(receipt),
        });
      }));

    test("append with the same ID and a different hash fails with CommandConflict", () =>
      Effect.gen(function* () {
        const store = yield* MailboxStore;
        yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
        const failure = yield* Effect.flip(
          store.append({ commandId: id("a"), payload: "2", payloadHash: 2 }),
        );
        expect(failure._tag).toBe("CommandConflict");
        expect(yield* store.pending).toEqual([id("a")]);
      }));

    test("commit advances one monotonic revision and updates latest", () =>
      Effect.gen(function* () {
        const store = yield* MailboxStore;
        yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
        yield* store.append({ commandId: id("b"), payload: "2", payloadHash: 2 });
        const first = yield* store.commit(id("a"), "s1");
        expect(first).toEqual({ commandId: id("a"), admitted: 1, revision: 1, state: "s1" });
        expect(yield* store.latest).toEqual(Option.some({ revision: 1, state: "s1" }));
        const next = yield* store.next;
        expect(Option.map(next, (command) => command.commandId)).toEqual(Option.some(id("b")));
        const second = yield* store.commit(id("b"), "s2");
        expect(second.revision).toBe(2);
        expect(yield* store.next).toEqual(Option.none());
        expect(yield* store.pending).toEqual([]);
      }));

    test("advance commits a state with no command and shares the revision clock", () =>
      Effect.gen(function* () {
        const store = yield* MailboxStore;
        const first = yield* store.advance("s1");
        expect(first).toEqual({ revision: 1, state: "s1" });
        yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
        const receipt = yield* store.commit(id("a"), "s2");
        expect(receipt.revision).toBe(2);
        const third = yield* store.advance("s3");
        expect(third.revision).toBe(3);
        expect(yield* store.latest).toEqual(Option.some({ revision: 3, state: "s3" }));
        expect(yield* store.pending).toEqual([]);
      }));

    test("receipt is absent until commit and stable after it", () =>
      Effect.gen(function* () {
        const store = yield* MailboxStore;
        yield* store.append({ commandId: id("a"), payload: "1", payloadHash: 1 });
        expect(yield* store.receipt(id("a"))).toEqual(Option.none());
        expect(yield* store.receipt(id("missing"))).toEqual(Option.none());
        const receipt = yield* store.commit(id("a"), "s1");
        expect(yield* store.receipt(id("a"))).toEqual(Option.some(receipt));
        expect(yield* store.receipt(id("a"))).toEqual(Option.some(receipt));
      }));
  });
};
