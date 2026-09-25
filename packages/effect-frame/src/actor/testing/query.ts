import type { Layer as LayerType } from "effect";
import type { AnyImplementation } from "../implement.js";
import { make as makeHost, memoryStore } from "../host.js";
import type { Policies, PolicyNamesMissing } from "../policy.js";
import type { AnyQueryImplementation } from "../query-host.js";
import { QueryCache } from "../query-client.js";
import type { ActorTransport } from "../transport.js";

export interface LayerOptions<R> {
  /** Canonical `implementQuery` and `implementBatchedQuery` descriptors. */
  readonly queries: ReadonlyArray<AnyQueryImplementation<R>>;
  /** Optional real actors for command-driven invalidation tests. */
  readonly implementations?: ReadonlyArray<AnyImplementation<R>>;
}

/**
 * Builds one local host and the real QueryCache around it. Query handlers
 * remain server implementations; the cache sees only ActorTransport. The
 * host requires `Policies` like every host: a test names its table too.
 */
export const layer = <R>(
  options: LayerOptions<R>,
): LayerType.Layer<QueryCache | ActorTransport, PolicyNamesMissing, R | Policies> =>
  QueryCache.layerTest(
    makeHost({
      implementations: options.implementations ?? [],
      queries: options.queries,
      store: memoryStore,
    }),
  );
