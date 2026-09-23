import { Effect, Exit, Layer, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  Behavior,
  Policies,
  Policy,
  PolicyNamesMissing,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import type { PolicyTable } from "effect-frame/actor";
import { ActorTransport, contract, query, ref } from "effect-frame/actor/client";

/**
 * A required table, validated at construction (#20 §3). A host whose
 * contracts or queries name a policy the table does not hold never becomes
 * a transport. There is no default table and no built-in name.
 */

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const counterOf = <const Name extends string, const Named extends string>(
  name: Name,
  policy: Named,
) =>
  contract(name, {
    version: 1,
    policy,
    key: Schema.String,
    snapshot: Schema.Finite,
    message: Schema.Union([Add]),
  });

const counting = Behavior.reducer<number, Add>({
  initial: 0,
  reduce: (state, message) => state + message.amount,
});

const Guarded = counterOf("Guarded", "missing");
const Audited = counterOf("Audited", "auditors");
const Open = counterOf("Open", "public");

const Totals = query("Totals", {
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "finance",
});
const TotalsLive = implementQuery(Totals, () => Effect.succeed(0));

const withTable = (table: PolicyTable) => Layer.succeed(Policies, table);

/** Builds the layer once and returns how it exited. */
const build = <E>(layer: Layer.Layer<ActorTransport, E>) =>
  Effect.exit(Effect.scoped(Layer.build(layer)));

const missingOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.match(exit, {
    onSuccess: () => [],
    onFailure: (cause) =>
      cause.reasons.flatMap((reason) => {
        if (reason._tag === "Fail" && Schema.is(PolicyNamesMissing)(reason.error)) {
          return reason.error.missing;
        }
        return [];
      }),
  });

describe("a required policy table", () => {
  it.effect("a host whose table lacks a named policy fails to build", () =>
    Effect.gen(function* () {
      const exit = yield* build(
        ActorHost.layerMemory([implementTransparent(Guarded, counting)]).pipe(
          Layer.provide(withTable({})),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(exit.pipe(missingOf)).toEqual([
        { subject: "actor", name: "Guarded", policy: "missing" },
      ]);
    }),
  );

  it.effect("the failure names every missing policy, not the first", () =>
    Effect.gen(function* () {
      const exit = yield* build(
        ActorHost.layerMemory(
          [implementTransparent(Guarded, counting), implementTransparent(Audited, counting)],
          [TotalsLive],
        ).pipe(Layer.provide(withTable({ unrelated: Policy.allowAll }))),
      );
      expect(exit.pipe(missingOf)).toEqual([
        { subject: "actor", name: "Guarded", policy: "missing" },
        { subject: "actor", name: "Audited", policy: "auditors" },
        { subject: "query", name: "Totals", policy: "finance" },
      ]);
    }),
  );

  it.effect("allow-all must be named", () =>
    Effect.gen(function* () {
      const OpenLive = implementTransparent(Open, counting);

      // No table entry: `public` is a name like any other, not a built-in.
      const refused = yield* build(
        ActorHost.layerMemory([OpenLive]).pipe(Layer.provide(withTable({}))),
      );
      expect(refused.pipe(missingOf)).toEqual([
        { subject: "actor", name: "Open", policy: "public" },
      ]);

      // Registered by name, it serves every caller.
      const served = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* ActorHost.make({ implementations: [OpenLive] }).pipe(
            Effect.provideService(Policies, { public: Policy.allowAll }),
          );
          const counter = yield* ref(Open, "anyone").pipe(
            Effect.provideService(ActorTransport, host),
          );
          const applied = yield* counter.call({ _tag: "Add", amount: 2 }, { timeout: "1 second" });
          return applied.state;
        }),
      );
      expect(served).toBe(2);
    }),
  );
});
