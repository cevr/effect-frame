import type { Effect } from "effect";
import { Option } from "effect";
import type { Entered } from "./codec.js";
import type { LocationService } from "./router.js";
import type { NavigationBehavior } from "./navigation-behavior.js";

/**
 * PRIVATE (#31). What passes between a mounted route, the router, and the
 * `Location` at shell commit. See `docs/design/navigation-behavior.md`.
 *
 * - A mounted route reports its `Shell`: whether the deepest segment
 *   entered in the commit that just ran, the destination leaf's own
 *   behavior, and the host node at that leaf's root.
 * - The router resolves it to one `Landing` and hands it to the Location:
 *   through the `Traversal` for a Back or Forward it held, through the
 *   `Written` handle of its own push or replace, and through the Location's
 *   `Surface` for a followed pop.
 * - The Location places the viewport and focus. Only a browser Location
 *   does anything; a memory Location and a server render have no surface.
 */

/** What one committed shell offers. */
export interface Shell {
  /** The deepest segment entered in this commit. False: it stayed. */
  readonly entered: boolean;
  /** The destination leaf's own behavior. None: the router's default. */
  readonly behavior: Option.Option<NavigationBehavior>;
  /** The host node at the deepest segment's root, once it is in the document. */
  readonly root: Effect.Effect<Option.Option<unknown>>;
  /**
   * Completes when the committed branch is drawn: every instance from the
   * root down built its view, or a pending fallback stands for the rest.
   * Queries are not waited on: a `Loading` fallback is part of the shell.
   */
  readonly drawn: Effect.Effect<void>;
}

/** What the Location places, once, when the shell is in the document. */
export interface Landing {
  readonly behavior: NavigationBehavior;
  /** The entering leaf's root host node. None: nothing entered, or it is not drawn yet. */
  readonly focus: Option.Option<unknown>;
}

/** How the router's own move writes history. */
export type WriteKind = "push" | "replace";

/**
 * One history write the router made, bound to that write alone. `land`
 * places the write's landing and releases it; `None` releases it without
 * placing anything (the router failed to show it, a newer move superseded
 * it, or it was a redirect inside another move). Each write is landed once.
 */
export interface Written {
  readonly land: (landing: Option.Option<Landing>) => Effect.Effect<void>;
}

/**
 * A Location that places the viewport and focus. `write` makes the router's
 * own push or replace and returns its handle; `pop` places a followed pop,
 * which the platform already committed.
 */
export interface Surface {
  readonly write: (kind: WriteKind, url: URL) => Effect.Effect<Written>;
  readonly pop: (landing: Option.Option<Landing>) => Effect.Effect<void>;
}

const shells = new WeakMap<object, Effect.Effect<Shell>>();

/** Attach the shell reader to a mounted route value without changing `Entered`. */
export const registerShell = <R>(entered: Entered<R>, shell: Effect.Effect<Shell>): void => {
  shells.set(entered, shell);
};

/** The shell a mounted route reports. None: a route the framework did not build. */
export const readShell = <R>(entered: Entered<R>): Option.Option<Effect.Effect<Shell>> =>
  Option.fromNullishOr(shells.get(entered));

const surfaces = new WeakMap<LocationService, Surface>();

/** Attach a surface to a location service, and return the service. */
export const registerSurface = (location: LocationService, surface: Surface): LocationService => {
  surfaces.set(location, surface);
  return location;
};

/** The surface of a location, when it has one. */
export const readSurface = (location: LocationService): Option.Option<Surface> =>
  Option.fromNullishOr(surfaces.get(location));
