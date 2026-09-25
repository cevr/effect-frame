import { query } from "effect-frame/actor/client";
import { Effect, Schema } from "effect";

/** The reads the feature examples share. Browser safe. */
export const TenantInfo = query("TenantInfo", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Struct({ name: Schema.String }),
  policy: "tenantMember",
  depends: [],
});

/** Whether the reader may see a tenant. An example's stand-in for a session read. */
export const isSignedIn = (tenant: string): Effect.Effect<boolean> =>
  Effect.succeed(tenant.length > 0);
