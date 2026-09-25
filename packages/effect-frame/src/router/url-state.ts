import type { Scope } from "effect";
import { Effect } from "effect";
import { Runtime } from "./url-state-runtime.js";
export { UrlStateConflict, UrlStateSchemaRejected } from "./url-state-runtime.js";
export type { Change, Options, State } from "./url-state-runtime.js";
import type { Options, State } from "./url-state-runtime.js";
import type { SearchCodec } from "./codec.js";

/**
 * Define URL-owned state in a view setup. The returned source derives from
 * the router's current URL, and every mutation is serialized by the router.
 */
export const make = <S extends SearchCodec>(
  codec: S,
  options?: Options,
): Effect.Effect<State<S["Type"]>, never, Runtime | Scope.Scope> =>
  Effect.flatMap(Runtime, (runtime) => runtime.make(codec, options));
