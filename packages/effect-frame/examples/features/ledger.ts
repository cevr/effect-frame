import { Behavior, contract, query } from "effect-frame/actor/client";
import { Schema } from "effect";

// #region contract
// Every contract and every query names a policy. The name is a key into
// the host's table, which holds the rule.
export const Entry = Schema.TaggedStruct("Entry", { text: Schema.String });
export type Entry = Schema.Schema.Type<typeof Entry>;

export const Ledger = contract("Ledger", {
  version: 1,
  policy: "tenantMember",
  key: Schema.Struct({ tenant: Schema.String, id: Schema.String }),
  snapshot: Schema.Finite,
  message: Entry,
});

export const Totals = query("Totals", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "tenantMember",
  depends: [Ledger],
});
// #endregion contract

export const ledgerBehavior = Behavior.reducer<number, Entry>({
  initial: 0,
  reduce: (count) => count + 1,
});
