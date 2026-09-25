import { Clock, Context, Effect, Option } from "effect";
import type { Scope } from "effect";
import type { CommandLifecycle, QueryValue } from "../frame.js";

export type { CommandLifecycle, QueryValue } from "../frame.js";

/**
 * The records in this module are deliberately smaller than the public
 * snapshot. They are the internal memory boundary between the framework
 * primitives and `Frame.inspect`.
 */

export interface OwnerToken {
  readonly id: string;
  readonly parentId: Option.Option<string>;
}

export interface ActorRecord {
  readonly _tag: "Actor";
  readonly id: string;
  readonly ownerId: string;
  readonly parentOwnerId: Option.Option<string>;
  readonly kind: "local" | "durable";
  readonly revision: number;
}

export type QueryStateTag = "Loading" | "Ready" | "Failed";

export interface QueryRecord {
  readonly _tag: "Query";
  readonly id: string;
  readonly ownerId: string;
  readonly parentOwnerId: Option.Option<string>;
  readonly cacheId: string;
  readonly key: string;
  readonly state: QueryStateTag;
  readonly stale: Option.Option<boolean>;
  readonly ageMs: number;
  readonly value: QueryValue;
  readonly failure: Option.Option<unknown>;
}

export interface MountRecord {
  readonly _tag: "Mount";
  readonly id: string;
  readonly ownerId: string;
  readonly parentOwnerId: Option.Option<string>;
  readonly phase: "entering" | "mounted";
}

export interface RouteRecord {
  readonly _tag: "Route";
  readonly id: string;
  readonly ownerId: string;
  readonly parentOwnerId: Option.Option<string>;
  readonly routerId: string;
  readonly routeInstanceId: string;
  readonly routeName: string;
  readonly phase: "entering" | "mounted";
  readonly params: unknown;
  readonly search: unknown;
  readonly canonicalRouteName: string;
  readonly canonicalUrl: string;
}

export interface UrlStateRecord {
  readonly _tag: "UrlState";
  readonly id: string;
  readonly ownerId: string;
  readonly parentOwnerId: Option.Option<string>;
  readonly routeInstanceId: string;
  readonly keys: ReadonlyArray<string>;
  readonly value: unknown;
}

/**
 * One command record the owner retains now. It is read from the owner's own
 * record; no payload or message is part of it.
 */
export interface CommandRecord {
  readonly _tag: "Command";
  readonly id: string;
  readonly ownerId: string;
  readonly parentOwnerId: Option.Option<string>;
  readonly kind: "durable" | "remote";
  readonly commandId: string;
  readonly identity: "fresh" | "supplied";
  /** Passes in the current or last sequence. */
  readonly attempt: number;
  /** True while an automatic sequence is running. */
  readonly running: boolean;
  readonly lifecycle: CommandLifecycle;
}

export type Record =
  | ActorRecord
  | QueryRecord
  | MountRecord
  | RouteRecord
  | UrlStateRecord
  | CommandRecord;

export interface Sample {
  readonly rootId: string;
  readonly rootName: Option.Option<string>;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly records: ReadonlyArray<Record>;
}

interface Registration {
  readonly token: symbol;
  readonly owner: OwnerToken;
  readonly read: (id: string) => Effect.Effect<Record>;
}

export interface RegistryService {
  readonly rootId: string;
  readonly rootName: Option.Option<string>;
  readonly rootOwner: OwnerToken;
  readonly makeOwner: (parent: Option.Option<OwnerToken>) => Effect.Effect<OwnerToken>;
  readonly register: (
    owner: OwnerToken,
    read: (id: string) => Effect.Effect<Record>,
  ) => Effect.Effect<string, never, Scope.Scope>;
  readonly sample: Effect.Effect<Sample>;
}

export class Registry extends Context.Service<Registry, RegistryService>()(
  "effect-frame/src/inspection/registry",
) {}

export class Owner extends Context.Service<Owner, OwnerToken>()(
  "effect-frame/src/inspection/registry/Owner",
) {}

/** A new owner under the `Owner` in context, or under none. */
export const ownerFor = (registry: RegistryService): Effect.Effect<OwnerToken> =>
  Effect.flatMap(Effect.serviceOption(Owner), registry.makeOwner);

export const makeRegistry = (
  name: Option.Option<string>,
): Effect.Effect<RegistryService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    // Browser Crypto gives each root an identity independent of app Clock and
    // Random test services. It is allocated once when the root is built.
    // oxlint-disable-next-line effect/noGlobals -- browser-safe root identity
    const rootId = `frame-root-${crypto.randomUUID()}`;
    const rootName = name;
    const registrations = new Map<string, Registration>();
    let ownerSequence = 0;
    let recordSequence = 0;

    const makeOwner = (parent: Option.Option<OwnerToken>): Effect.Effect<OwnerToken> =>
      Effect.sync(() => {
        ownerSequence += 1;
        return {
          id: `${rootId}-owner-${ownerSequence}`,
          parentId: Option.map(parent, (value) => value.id),
        };
      });

    const rootOwner = yield* makeOwner(Option.none());

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        registrations.clear();
      }),
    );

    const register: RegistryService["register"] = (owner, read) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          recordSequence += 1;
          const id = `${rootId}-record-${recordSequence}`;
          const token = Symbol(id);
          registrations.set(id, { token, owner, read });
          return { id, token };
        }),
        ({ id, token }) =>
          Effect.sync(() => {
            const current = Option.fromNullishOr(registrations.get(id));
            if (Option.isSome(current) && current.value.token === token) {
              registrations.delete(id);
            }
          }),
      ).pipe(Effect.map(({ id }) => id));

    const sample = Effect.gen(function* () {
      const startedAt = clock.currentTimeMillisUnsafe();
      const copied = Array.from(registrations.entries());
      const records: Array<Record> = [];

      for (const [id, registration] of copied) {
        const current = Option.fromNullishOr(registrations.get(id));
        if (Option.isNone(current) || current.value.token !== registration.token) {
          continue;
        }
        const record = yield* registration.read(id);
        const stillLive = Option.fromNullishOr(registrations.get(id));
        if (Option.isSome(stillLive) && stillLive.value.token === registration.token) {
          records.push(record);
        }
      }

      return {
        rootId,
        rootName,
        startedAt,
        finishedAt: clock.currentTimeMillisUnsafe(),
        records,
      } satisfies Sample;
    });

    return {
      rootId,
      rootName,
      rootOwner,
      makeOwner,
      register,
      sample,
    } satisfies RegistryService;
  });
