import { Effect, Predicate, Schema } from "effect";
import type { DurableSendOptions } from "./vocabulary.js";
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

/**
 * Fresh-ID ownership. Some framework sends must know their
 * command ID before the send: a message with a field generated from it
 * (`Generated.send`), and a form whose own ID was drawn into its markup
 * (`View.form`). The framework minted that ID for this one send, so nothing
 * else can hold it, and it is as fresh as one the reference mints itself: it
 * predicts, and a first refusal is conclusive.
 *
 * Provenance is identity, not shape. The options object `mintedFor` made is
 * recorded in a module-private `WeakSet` and frozen, so its ID cannot change
 * after it was recorded. No property, symbol, or `Proxy` trap can claim it:
 * an ID an application supplies stays supplied, whatever its origin. The
 * record is for one send: the first check consumes it.
 */
const minted = new WeakSet<object>();

/** Send options for an ID the framework minted for this send alone. Internal. */
export const mintedFor = (commandId: CommandId): DurableSendOptions => {
  const options: DurableSendOptions = Object.freeze({ commandId });
  minted.add(options);
  return options;
};

/**
 * Whether these options are the ones the framework minted for this send.
 * Internal. It answers true once: the check consumes the registration, so
 * the same frozen options sent again (an application wrapper that kept
 * them) are a supplied ID, whose ID is already used. The one send path
 * that asks (`Actor.remote`'s `send`) asks once per send.
 */
export const isMinted = (options: DurableSendOptions | void): boolean =>
  Predicate.isObject(options) && minted.delete(options);
