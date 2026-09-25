import { durable } from "./durable.js";
import { Actor as ClientActor } from "./placement.js";

/**
 * Every placement, with the one only a server holds. It is the client's
 * `Actor` (`local`, `remote`, `remoteCommands`) plus `Actor.durable`: an
 * actor whose state and mailbox live in the `MailboxStore` in context, so
 * it survives a restart. A browser bundle never carries a store, so the
 * client entry has no `durable`.
 *
 * @example
 * ```ts
 * const counter = yield* Actor.durable({
 *   behavior: Behavior.value(0),
 *   state: Schema.fromJsonString(Schema.Finite),
 *   message: Schema.fromJsonString(SetMessage),
 * });
 * ```
 */
export const Actor = { ...ClientActor, durable };
