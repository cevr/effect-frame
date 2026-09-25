import { local } from "./actor.js";
import { remote, remoteCommands } from "./ref.js";

/**
 * Where an actor runs, named at the call. Each constructor is named after
 * the `kind` its reference carries, so the placement a reader sees at the
 * call is the placement the types check.
 *
 * - `Actor.local(behavior)`: an actor in this process, stopped when the
 *   current `Scope` closes. A view's own state is one:
 *   `Actor.local(Behavior.value(initial))`.
 * - `Actor.remote(contract, key, options)`: a reference to an actor a host
 *   serves, read and commanded through `ActorTransport`.
 * - `Actor.remoteCommands(contract, key)`: a reference that only sends. It
 *   reads no snapshot and follows no change stream.
 *
 * The server entry (`effect-frame/actor`) adds `Actor.durable`, an actor
 * whose state and mailbox live in the `MailboxStore` in context.
 *
 * @example
 * ```ts
 * const draft = yield* Actor.local(Behavior.value(""));
 * const counter = yield* Actor.remote(Counter, "main", { resume: Option.none() });
 * const commands = yield* Actor.remoteCommands(Counter, "main");
 * ```
 */
export const Actor = { local, remote, remoteCommands };
