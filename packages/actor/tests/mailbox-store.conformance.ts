import type { Layer } from "effect";
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { MailboxStore } from "@effect-frame/actor";
import type { StoreFactory } from "@effect-frame/actor/testing";
import { factoryFromLayer, mailboxStoreConformance } from "@effect-frame/actor/testing";

/**
 * Runs the shared conformance suite under `bun test`. The suite itself is a
 * pure Effect, so a host without a test runner can run the same cases.
 */
export const runConformance = (name: string, factory: StoreFactory) => {
  describe(`MailboxStore conformance: ${name}`, () => {
    it.effect("every case passes", () =>
      Effect.gen(function* () {
        const cases = yield* mailboxStoreConformance(factory);
        const failed = cases.filter((result) => !result.passed);
        expect(failed.map((result) => `${result.name} — ${result.detail}`)).toEqual([]);
        expect(cases.length).toBeGreaterThan(6);
      }),
    );
  });
};

/** The suite over a layer that builds a fresh, empty store for each case. */
export const mailboxStoreConformanceLayer = (name: string, layer: Layer.Layer<MailboxStore>) =>
  runConformance(name, factoryFromLayer(layer));
