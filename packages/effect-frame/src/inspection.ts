import { Clock, Context, Effect, Option, Random } from "effect";
import type { Scope } from "effect";

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

export type QueryValue =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Encoded"; readonly encoding: "json"; readonly value: string }
  | { readonly _tag: "Unsupported"; readonly reason: string };

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

export type Record = ActorRecord | QueryRecord | MountRecord | RouteRecord | UrlStateRecord;

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
  readonly makeOwner: (parent: Option.Option<OwnerToken>) => OwnerToken;
  readonly register: (
    owner: OwnerToken,
    read: (id: string) => Effect.Effect<Record>,
  ) => Effect.Effect<string, never, Scope.Scope>;
  readonly sample: Effect.Effect<Sample>;
}

export class Registry extends Context.Service<Registry, RegistryService>()(
  "effect-frame/src/inspection/Registry",
) {}

export class Owner extends Context.Service<Owner, OwnerToken>()(
  "effect-frame/src/inspection/Owner",
) {}

export const ownerFor = (registry: RegistryService): Effect.Effect<OwnerToken> =>
  Effect.map(Effect.serviceOption(Owner), (parent) =>
    Option.match(parent, {
      onNone: () => registry.makeOwner(Option.none()),
      onSome: (value) => registry.makeOwner(Option.some(value)),
    }),
  );

export const makeRegistry = (
  name: Option.Option<string>,
): Effect.Effect<RegistryService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const rootNonce = yield* Random.nextInt;
    const rootId = `frame-root-${String(clock.currentTimeMillisUnsafe())}-${String(rootNonce)}`;
    const rootName = name;
    const registrations = new Map<string, Registration>();
    let ownerSequence = 0;
    let recordSequence = 0;

    const makeOwner = (parent: Option.Option<OwnerToken>): OwnerToken => {
      ownerSequence += 1;
      return {
        id: `${rootId}-owner-${ownerSequence}`,
        parentId: Option.map(parent, (value) => value.id),
      };
    };

    const rootOwner = makeOwner(Option.none());

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
