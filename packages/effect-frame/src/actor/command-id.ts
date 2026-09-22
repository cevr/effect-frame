import { Effect, Schema } from "effect";
import { CommandId } from "./vocabulary.js";

const decodeCommandId = Schema.decodeSync(CommandId);

/**
 * The platform boundary for framework command identity.
 *
 * A framework-created durable or remote command ID comes from the native
 * secure UUID source that browsers and Bun both provide. It never comes from
 * the application's `Random` service, which a test may seed and which is not
 * a freshness guarantee. Reading the platform source here keeps every actor
 * reference free of a new required service.
 */
export const freshCommandId: Effect.Effect<CommandId> = Effect.sync(() =>
  // oxlint-disable-next-line effect/noGlobals -- native secure UUID source at the platform boundary
  decodeCommandId(crypto.randomUUID()),
);
