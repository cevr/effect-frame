import type { Layer as LayerType, Scope } from "effect";
import { Context, Effect, Layer, Option, Semaphore, Stream } from "effect";
import type { Address } from "./contract.js";
import type { AnyImplementation, HostedInstance } from "./implement.js";
import { MailboxStore } from "./mailbox-store.js";
import type { Action, Declared, PolicyNamesMissing } from "./policy.js";
import { Policies, lookup, validate } from "./policy.js";
import { CurrentPrincipal } from "./principal.js";
import type { QueryKey } from "./query.js";
import { UnknownQuery } from "./query.js";
import type { AnyQueryImplementation, QueryServing } from "./query-host.js";
import { make as makeQueryServing } from "./query-host.js";
import type { Refreshed, TransportService } from "./transport.js";
import { ActorTransport } from "./transport.js";
import type { RemoteFailure } from "./vocabulary.js";
import { ContractMismatch, Unauthorized, UnknownContract } from "./vocabulary.js";

export interface HostOptions<R> {
  readonly implementations: ReadonlyArray<AnyImplementation<R>>;
  /**
   * The mailbox store for one address. Omitted, every actor gets a fresh
   * in-memory store: right for a host that serves queries alone or for a
   * test, and a host whose actors must survive a restart names its store.
   */
  readonly store?: (address: Address) => LayerType.Layer<MailboxStore>;
  /**
   * The queries this host serves. They are built here and not in a
   * layer beside this one, because a query handler reads actors through
   * this host's own transport: a second host would open a second set of
   * instances. Omit it and the host serves actors alone.
   */
  readonly queries?: ReadonlyArray<AnyQueryImplementation<R>>;
}

const addressKey = (address: Address) => `${address.contract}@${address.version}/${address.key}`;

const unknownQueryRefresh = (key: QueryKey): Refreshed => ({
  _tag: "RefreshFailed",
  key,
  error: UnknownQuery.make({ query: key.query }),
});

/**
 * Every policy name this host's contracts and queries declare. The host
 * validates them all before it becomes a transport.
 */
const declaredBy = <R>(
  implementations: ReadonlyArray<AnyImplementation<R>>,
  queries: ReadonlyArray<AnyQueryImplementation<R>>,
): ReadonlyArray<Declared> => [
  ...implementations.map((implementation): Declared => ({
    subject: "actor",
    name: implementation.contract.name,
    policy: implementation.contract.policy,
  })),
  ...queries.map((implementation): Declared => ({
    subject: "query",
    name: implementation.contract.name,
    policy: implementation.contract.policy,
  })),
];

/** What `Recovery` does. */
export interface RecoveryService {
  /**
   * Opens the actor at `address` if it is not open: that restores its
   * committed state, drains the commands already admitted, and re-enters
   * its machine work. It returns no state.
   */
  readonly wake: (address: Address) => Effect.Effect<void, UnknownContract | ContractMismatch>;
}

/**
 * The host's own wake, with no caller. A durable host that restarts
 * must drain what it already admitted, and no principal is present to ask.
 * It checks no policy, because it serves nothing: every command it drains
 * was authorized when it was admitted, and it returns no state. It is
 * server-only and never on the wire: `ActorHost.layer` provides it beside
 * the transport, and only a host adapter (a celld alarm) reads it.
 */
export class Recovery extends Context.Service<Recovery, RecoveryService>()(
  "effect-frame/src/actor/host/Recovery",
) {}

interface Built {
  readonly transport: TransportService;
  readonly recovery: RecoveryService;
}

/**
 * Builds the host. It requires `Policies` and fails with
 * `PolicyNamesMissing` before it serves anything when a contract or a query
 * names a policy the table does not hold.
 */
export const make = <R>(
  options: HostOptions<R>,
): Effect.Effect<TransportService, PolicyNamesMissing, R | Policies | Scope.Scope> =>
  Effect.map(build(options), (built) => built.transport);

const build = <R>(
  options: HostOptions<R>,
): Effect.Effect<Built, PolicyNamesMissing, R | Policies | Scope.Scope> =>
  Effect.gen(function* () {
    const hostScope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const policies = yield* Policies;
    const queries = Option.getOrElse(
      Option.fromNullishOr(options.queries),
      (): ReadonlyArray<AnyQueryImplementation<R>> => [],
    );
    yield* validate(declaredBy(options.implementations, queries), policies);
    const lock = yield* Semaphore.make(1);
    const byName = new Map(
      options.implementations.map((implementation) => [
        implementation.contract.name,
        implementation,
      ]),
    );
    const instances = new Map<string, HostedInstance>();
    const store = options.store ?? (() => MailboxStore.layerMemory);

    const find = (
      address: Address,
    ): Effect.Effect<AnyImplementation<R>, UnknownContract | ContractMismatch> =>
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
            implementation.open(store(address), hostScope),
            context,
          );
          instances.set(key, instance);
          return instance;
        }),
      );

    /**
     * Look up, then authorize, then open. A refused caller never causes an
     * instance to be created, so a read cannot be used to spin up actors.
     */
    const authorize = (implementation: AnyImplementation<R>, address: Address, action: Action) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        const policy = lookup(policies, implementation.contract.policy);
        if (Option.isNone(policy)) {
          // Unreachable: every name was validated above.
          return yield* Unauthorized.make({ contract: address.contract });
        }
        return yield* policy.value.check(principal, { _tag: "Actor", address }, action);
      });

    const resolve = (
      address: Address,
      action: Action,
    ): Effect.Effect<HostedInstance, RemoteFailure> =>
      Effect.gen(function* () {
        const implementation = yield* find(address);
        yield* authorize(implementation, address, action);
        return yield* open(address, implementation);
      });

    /**
     * The query half, once it exists. It is set after the transport object
     * is made, because the handlers read actors through that same transport.
     * One host, one knot, tied in one place.
     */
    let serving: Option.Option<QueryServing> = Option.none();

    /**
     * Single flight. The command has committed; now, in the same reply, the
     * host reads the caller's active queries that declared a dependency on
     * this contract. The scope is one command: only keys the caller sent,
     * only queries that name this contract. A refresh that fails answers
     * with its error, never with a failed command.
     */
    const refreshFor = (
      contractName: string,
      active: ReadonlyArray<QueryKey>,
    ): Effect.Effect<ReadonlyArray<Refreshed>> => {
      if (active.length === 0 || Option.isNone(serving)) {
        return Effect.succeed([]);
      }
      const query = serving.value;
      const stale = query.dependents(contractName, active);
      if (stale.length === 0) {
        return Effect.succeed([]);
      }
      return query.batch(stale);
    };

    const transport: TransportService = {
      send: (address, commandId, payload, active) =>
        Effect.flatMap(resolve(address, "send"), (instance) =>
          Effect.flatMap(instance.send(commandId, payload), (receipt) =>
            Option.match(receipt.committed, {
              onNone: () => Effect.succeed({ receipt, refreshed: [] }),
              onSome: () =>
                Effect.map(refreshFor(address.contract, active), (refreshed) => ({
                  receipt,
                  refreshed,
                })),
            }),
          ),
        ),
      call: (address, commandId, payload, timeout, active) =>
        Effect.flatMap(resolve(address, "send"), (instance) =>
          Effect.flatMap(instance.call(commandId, payload, timeout), (projection) =>
            Effect.map(refreshFor(address.contract, active), (refreshed) => ({
              projection,
              refreshed,
            })),
          ),
        ),
      snapshot: (address) =>
        Effect.flatMap(resolve(address, "read"), (instance) => instance.snapshot),
      query: (key) =>
        Option.match(serving, {
          onNone: () => Effect.fail(UnknownQuery.make({ query: key.query })),
          onSome: (query) => query.get(key),
        }),
      queryBatch: (keys) =>
        Option.match(serving, {
          onNone: () => Effect.succeed(keys.map(unknownQueryRefresh)),
          onSome: (query) => query.batch(keys),
        }),
      changes: (address, after) =>
        Stream.unwrap(Effect.map(resolve(address, "read"), (instance) => instance.changes(after))),
    };

    // Tie the knot: the handlers read actors through the transport above.
    if (queries.length > 0) {
      serving = Option.some(yield* makeQueryServing({ queries, policies }, transport));
    }
    const recovery: RecoveryService = {
      wake: (address) =>
        Effect.asVoid(
          Effect.flatMap(find(address), (implementation) => open(address, implementation)),
        ),
    };
    const built: Built = { transport, recovery };
    return built;
  });

/**
 * Hosts implementations in this process and serves them as the transport.
 * The same layer works for a server and for a test that keeps the client
 * and the server in one runtime.
 */
export const layer = <R>(
  options: HostOptions<R>,
): LayerType.Layer<ActorTransport | Recovery, PolicyNamesMissing, R | Policies> =>
  Layer.effectContext(
    Effect.map(build(options), (built) =>
      Context.make(ActorTransport, built.transport).pipe(
        Context.add(Recovery, Recovery.of(built.recovery)),
      ),
    ),
  );

export const layerMemory = <R>(
  implementations: ReadonlyArray<AnyImplementation<R>>,
  queries?: ReadonlyArray<AnyQueryImplementation<R>>,
): LayerType.Layer<ActorTransport | Recovery, PolicyNamesMissing, R | Policies> =>
  layer({ implementations, queries });
