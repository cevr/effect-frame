/**
 * How a mounted route tree renders a document (#18 §6, with the #22 names).
 * A mode is chosen by the constructor that makes the tree mountable
 * (`Route.client`, `Route.ssr`, `Route.streamed`, `Route.awaitAll`), and
 * the route carries it under its brand: no author writes a mode field, and
 * the router reads it with `modeOf`. See `docs/design/route-data.md`.
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

/**
 * The mode of the router's own not-found route: the server draws it, as
 * it draws any page, so a missing page is a real document with a 404.
 */
export const notFoundMode: RenderingMode = "SSR";
