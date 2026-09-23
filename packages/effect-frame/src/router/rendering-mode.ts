import { Option } from "effect";
import type { AnyRoute } from "./codec.js";

/**
 * How a mounted route tree renders a document (#18 §6, with the #22 names).
 * A mode is chosen by the constructor that makes the tree mountable
 * (`Route.client`, `Route.ssr`, `Route.streamed`, `Route.awaitAll`). No
 * route value carries it: the router reads it from this module's private
 * registry. See `docs/design/route-data.md`.
 *
 * - `ClientOnly`: the server writes the document with an empty mount
 *   element and reads nothing. The client mounts and reads every query.
 * - `SSR`: the server resolves every query the matched branch declares,
 *   then draws once. The settled values go in one seed script.
 * - `AwaitAll`: the server draws, then waits until the drawing waits for
 *   nothing: every read settled and no `Loading` shows its fallback.
 * - `Streamed`: the server writes the shell at once, then one record per
 *   query as it settles.
 */
export type RenderingMode = "ClientOnly" | "SSR" | "AwaitAll" | "Streamed";

const modes = new WeakMap<object, RenderingMode>();

/** Record the mode of a route its constructor made. */
export const register = <R>(route: AnyRoute<R>, mode: RenderingMode): void => {
  modes.set(route, mode);
};

/** The mode a constructor recorded. None: a hand-written route, or not-found. */
export const read = <R>(route: AnyRoute<R>): Option.Option<RenderingMode> =>
  Option.fromNullishOr(modes.get(route));
