import type { Layer as LayerType } from "effect";
import type { AnyImplementation } from "../implement.js";
import { make as makeHost } from "../host.js";
import type { AnyQueryImplementation } from "../query-host.js";
import { QueryCache } from "../query-client.js";
import type { ActorTransport } from "../transport.js";

export interface LayerOptions<R> {
  /** Canonical `implementQuery` and `Query.batched` descriptors. */
  readonly queries: ReadonlyArray<AnyQueryImplementation<R>>;
  /** Optional real actors for command-driven invalidation tests. */
  readonly implementations?: ReadonlyArray<AnyImplementation<R>>;
}

/**
 * Builds one local host and the real QueryCache around it. Query handlers
 * remain server implementations; the cache sees only ActorTransport.
 */
export const layer = <R>(
  options: LayerOptions<R>,
): LayerType.Layer<QueryCache | ActorTransport, never, R> =>
  QueryCache.layerTest(
    makeHost({
      implementations: options.implementations ?? [],
      queries: options.queries,
    }),
  );
