import type { Source } from "effect-frame/actor";
import { select } from "effect-frame/actor/client";
import type {
  RouteInstance,
  RouteNavigation,
  SearchCodec,
  SearchKeyInfo,
  SearchRecord,
} from "./codec.js";
import { mergeSearchRecord, readSearch, printSearch, searchKeysOf } from "./codec.js";
import type { RouterService } from "./router.js";
import type { Scope } from "effect";
import { Context, Effect, Option, Schema } from "effect";
import * as Inspection from "../inspection.js";

/** Explicit wire keys for an opaque SearchRecord codec. */
export interface Options {
  readonly keys?: ReadonlyArray<string>;
}

/** A mounted view's decoded state and its URL mutations. */
export interface State<A> {
  readonly state: Source<A>;
  /** Replace the current history entry. */
  readonly set: (value: A) => Effect.Effect<void>;
  /** Replace the current history entry after reading the latest value. */
  readonly update: (update: (previous: A) => A) => Effect.Effect<void>;
  /** Explicit push operations for callers that want a history entry. */
  readonly push: {
    readonly set: (value: A) => Effect.Effect<void>;
    readonly update: (update: (previous: A) => A) => Effect.Effect<void>;
  };
}

/** A view state schema must have a valid omitted-record fallback. */
export class UrlStateSchemaRejected extends Schema.TaggedError<UrlStateSchemaRejected>()(
  "UrlStateSchemaRejected",
  { reason: Schema.String },
) {}

/** A route or another view already owns one of the requested wire keys. */
export class UrlStateConflict extends Schema.TaggedError<UrlStateConflict>()("UrlStateConflict", {
  key: Schema.String,
}) {}

/**
 * Define URL-owned state in a view setup. The router provides the current
 * route instance and serializes every mutation; the view only supplies a
 * Schema codec and, for an opaque codec, its finite encoded key declaration.
 */
export interface RuntimeService {
  readonly make: <S extends SearchCodec>(
    codec: S,
    options?: Options,
  ) => Effect.Effect<State<S["Type"]>, never, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, RuntimeService>()(
  "effect-frame/src/router/url-state-runtime/Runtime",
) {}

interface Owner {
  readonly keys: ReadonlyArray<string>;
  active: boolean;
}

type Mutation<A> =
  | { readonly _tag: "Set"; readonly value: A }
  | { readonly _tag: "Update"; readonly update: (previous: A) => A };

/**
 * Bind the view-level URL-state constructor to one mounted route instance.
 * This is kept out of the public Router service implementation details so a
 * route transition can create a fresh claim registry before the old scope
 * closes.
 */
export const makeRuntime = (
  router: RouterService,
  navigation: RouteNavigation,
  routeKeys: SearchKeyInfo,
  instance: RouteInstance,
  routeInstanceId: Option.Option<string>,
  currentUrl: Effect.Effect<URL>,
): RuntimeService => {
  const owners = new Map<string, Owner>();

  const make = <S extends SearchCodec>(codec: S, options?: Options) => {
    const encode = Schema.encodeSync(codec);
    const option = Option.fromNullishOr(options);
    return Effect.gen(function* () {
      const codecKeys = searchKeysOf(codec);
      const keys = resolveKeys(codecKeys, option);
      if (!routeKeys.known) {
        return yield* Effect.die(
          UrlStateSchemaRejected.make({
            reason: "an opaque route search codec must declare searchKeys before UrlState.make",
          }),
        );
      }

      const decode = Schema.decodeUnknownOption(codec);
      const empty = decode(Object.create(null));
      if (Option.isNone(empty)) {
        return yield* Effect.die(
          UrlStateSchemaRejected.make({
            reason: "UrlState.make requires a codec that decodes an omitted record",
          }),
        );
      }
      const fallback = Option.getOrThrow(empty);
      const owner = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const routeKeySet = new Set(routeKeys.keys);
          for (const key of keys) {
            if (routeKeySet.has(key) || owners.has(key)) {
              return yield* Effect.die(UrlStateConflict.make({ key }));
            }
          }
          const claimed: Owner = { keys, active: true };
          for (const key of claimed.keys) {
            owners.set(key, claimed);
          }
          return claimed;
        }),
        (claimed) =>
          Effect.sync(() => {
            claimed.active = false;
            for (const key of claimed.keys) {
              if (owners.get(key) === claimed) {
                owners.delete(key);
              }
            }
          }),
      );

      const state = select(router.current, (match) => decodeUrl(codec, keys, fallback, match.url));

      const registry = yield* Effect.serviceOption(Inspection.Registry);
      const frameOwner = yield* Effect.serviceOption(Inspection.Owner);
      if (Option.isSome(registry) && Option.isSome(frameOwner) && Option.isSome(routeInstanceId)) {
        yield* registry.value.register(frameOwner.value, (id) =>
          Effect.map(currentUrl, (url) => ({
            _tag: "UrlState",
            id,
            ownerId: frameOwner.value.id,
            parentOwnerId: frameOwner.value.parentId,
            routeInstanceId: routeInstanceId.value,
            keys: [...keys],
            value: decodeUrl(codec, keys, fallback, url),
          })),
        );
      }
      const set = (value: S["Type"]): Effect.Effect<void> =>
        replaceOrPush("replace", { _tag: "Set", value });
      const update = (change: (previous: S["Type"]) => S["Type"]): Effect.Effect<void> =>
        replaceOrPush("replace", { _tag: "Update", update: change });
      const pushSet = (value: S["Type"]): Effect.Effect<void> =>
        replaceOrPush("push", { _tag: "Set", value });
      const pushUpdate = (change: (previous: S["Type"]) => S["Type"]): Effect.Effect<void> =>
        replaceOrPush("push", { _tag: "Update", update: change });

      const replaceOrPush = (
        operation: "push" | "replace",
        mutation: Mutation<S["Type"]>,
      ): Effect.Effect<void> => {
        const updater = (current: URL): string => {
          if (!owner.active) {
            return current.href;
          }
          let next: S["Type"];
          if (mutation._tag === "Set") {
            next = mutation.value;
          } else {
            next = mutation.update(decodeUrl(codec, keys, fallback, current));
          }
          return printValue(current, encode(next), keys);
        };
        if (operation === "push") {
          return navigation.navigate(updater, instance);
        }
        return navigation.replace(updater, instance);
      };

      return {
        state,
        set,
        update,
        push: { set: pushSet, update: pushUpdate },
      } satisfies State<S["Type"]>;
    });
  };
  return { make };
};

const resolveKeys = (
  codec: SearchKeyInfo,
  options: Option.Option<Options>,
): ReadonlyArray<string> => {
  const declared = Option.flatMap(options, (value) => Option.fromNullishOr(value.keys));
  if (Option.isSome(declared)) {
    if (codec.known && !sameKeys(codec.keys, declared.value)) {
      return Option.getOrThrowWith(Option.none(), () =>
        UrlStateSchemaRejected.make({
          reason: "UrlState keys must match the codec's declared encoded keys",
        }),
      );
    }
    return uniqueKeys(declared.value);
  }
  if (!codec.known) {
    return Option.getOrThrowWith(Option.none(), () =>
      UrlStateSchemaRejected.make({
        reason: "an opaque codec requires UrlState.make({ keys })",
      }),
    );
  }
  return codec.keys;
};

const uniqueKeys = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    return Option.getOrThrowWith(Option.none(), () =>
      UrlStateSchemaRejected.make({ reason: "UrlState keys must be unique" }),
    );
  }
  return [...keys];
};

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((key) => rightSet.has(key));
};

const decodeUrl = <S extends SearchCodec>(
  codec: S,
  keys: ReadonlyArray<string>,
  fallback: S["Type"],
  url: URL,
): S["Type"] => {
  const all = readSearch(url.searchParams);
  const owned: Record<string, ReadonlyArray<string>> = Object.create(null);
  for (const key of keys) {
    if (Object.hasOwn(all, key)) {
      owned[key] = Option.getOrThrow(Option.fromNullishOr(all[key]));
    }
  }
  return Option.getOrElse(Schema.decodeUnknownOption(codec)(owned), () => fallback);
};

const printValue = (current: URL, encoded: SearchRecord, keys: ReadonlyArray<string>): string => {
  const currentRecord = readSearch(current.searchParams);
  const encodedKeys = new Set(Object.keys(encoded));
  const keySet = new Set(keys);
  for (const key of encodedKeys) {
    if (!keySet.has(key)) {
      return Option.getOrThrowWith(Option.none(), () =>
        UrlStateSchemaRejected.make({ reason: `codec encoded undeclared URL key ${key}` }),
      );
    }
  }
  const merged = mergeSearchRecord(currentRecord, encoded, keys);
  const next = new URL(current.href);
  const search = printSearch(merged);
  next.search = search;
  return next.href;
};
