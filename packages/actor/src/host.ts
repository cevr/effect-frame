import type { Layer as LayerType } from "effect";
import { Context, Effect, Layer, Option, Semaphore, Stream } from "effect";
import type { Address } from "./contract.js";
import type { AnyImplementation, HostedInstance } from "./implement.js";
import { MailboxStore } from "./mailbox-store.js";
import type { TransportService } from "./transport.js";
import { ActorTransport } from "./transport.js";
import type { RemoteFailure, Unauthorized } from "./vocabulary.js";
import { ContractMismatch, UnknownContract } from "./vocabulary.js";

export type Action = "read" | "send";

/**
 * Decides whether the caller may read or send to one address. The key is
 * part of the address, so a tenant-scoped key is enough to scope access.
 * The default allows everything; a real host must replace it.
 */
export interface AuthorizerService {
  readonly authorize: (address: Address, action: Action) => Effect.Effect<void, Unauthorized>;
}

export const Authorizer = Context.Reference<AuthorizerService>(
  "@effect-frame/actor/src/host/Authorizer",
  { defaultValue: () => ({ authorize: () => Effect.void }) },
);

export interface HostOptions<R> {
  readonly implementations: ReadonlyArray<AnyImplementation<R>>;
  /** The mailbox store for one address. Defaults to a fresh in-memory store. */
  readonly store: (address: Address) => LayerType.Layer<MailboxStore>;
}

const addressKey = (address: Address) => `${address.contract}@${address.version}/${address.key}`;

const make = <R>(options: HostOptions<R>) =>
  Effect.gen(function* () {
    const hostScope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const authorizer = yield* Authorizer;
    const lock = yield* Semaphore.make(1);
    const byName = new Map(
      options.implementations.map((implementation) => [
        implementation.contract.name,
        implementation,
      ]),
    );
    const instances = new Map<string, HostedInstance>();

    const lookup = (address: Address) =>
      Option.match(Option.fromNullishOr(byName.get(address.contract)), {
        onNone: () => Effect.fail(UnknownContract.make({ contract: address.contract })),
        onSome: (implementation) => {
          if (implementation.contract.version !== address.version) {
            return Effect.fail(
              ContractMismatch.make({
                contract: address.contract,
                expected: implementation.contract.version,
                actual: address.version,
              }),
            );
          }
          return Effect.succeed(implementation);
        },
      });

    const open = (address: Address, implementation: AnyImplementation<R>) =>
      Semaphore.withPermits(
        lock,
        1,
      )(
        Effect.gen(function* () {
          const key = addressKey(address);
          const existing = Option.fromNullishOr(instances.get(key));
          if (Option.isSome(existing)) {
            return existing.value;
          }
          // The host is the boundary: each instance gets the host's context.
          // oxlint-disable-next-line effect/noInlineProvide
          const instance = yield* Effect.provide(
            implementation.open(options.store(address), hostScope),
            context,
          );
          instances.set(key, instance);
          return instance;
        }),
      );

    const resolve = (
      address: Address,
      action: Action,
    ): Effect.Effect<HostedInstance, RemoteFailure> =>
      Effect.gen(function* () {
        const implementation = yield* lookup(address);
        yield* authorizer.authorize(address, action);
        return yield* open(address, implementation);
      });

    const transport: TransportService = {
      send: (address, commandId, payload) =>
        Effect.flatMap(resolve(address, "send"), (instance) => instance.send(commandId, payload)),
      call: (address, commandId, payload, timeout) =>
        Effect.flatMap(resolve(address, "send"), (instance) =>
          instance.call(commandId, payload, timeout),
        ),
      snapshot: (address) =>
        Effect.flatMap(resolve(address, "read"), (instance) => instance.snapshot),
      changes: (address, after) =>
        Stream.unwrap(Effect.map(resolve(address, "read"), (instance) => instance.changes(after))),
    };
    return transport;
  });

/**
 * Hosts implementations in this process and serves them as the transport.
 * The same layer works for a server and for a test that keeps the client
 * and the server in one runtime.
 */
export const layer = <R>(options: HostOptions<R>): LayerType.Layer<ActorTransport, never, R> =>
  Layer.effect(ActorTransport, make(options));

export const layerMemory = <R>(
  implementations: ReadonlyArray<AnyImplementation<R>>,
): LayerType.Layer<ActorTransport, never, R> =>
  layer({ implementations, store: () => MailboxStore.layerMemory });
