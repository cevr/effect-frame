import { Context, Effect, Schema } from "effect";
import type { Option, Scope } from "effect";
import type { AnySegment, Declarations, Segment, Values } from "./branch.js";
import type { LeaveKind, LeaveVerdict } from "./leave-registry.js";
import type { RouterService } from "./router.js";
import { Router } from "./router.js";

export { Leave, Stay } from "./leave-registry.js";
export type { LeaveKind, LeaveVerdict } from "./leave-registry.js";

/**
 * PRIVATE (route slice 5). Scoped leave checks. Not exported from
 * `effect-frame/router`. See `docs/design/route-leave.md`.
 *
 * A mounted segment's view registers a check while it sets up. The check is
 * a closure, so it can read state that only that instance owns: a local
 * draft actor, a form. It unregisters when the Scope it was
 * registered in closes. The registration lives on the mounted instance, not
 * in a global registry and not on a DOM event.
 *
 * The router asks the relevant old instances before destination data opens
 * and before history commits: deepest first, stopping at the first `Stay`.
 * An instance is relevant when its segment exits, or stays with changed
 * params or search. An unchanged stayed segment is not asked.
 */

/** One candidate, as the segment that is asked sees it. Values, not Sources. */
export interface LeaveInput<Params, Search> {
  /** What this instance shows now. */
  readonly previous: Values<Params, Search>;
  /** The same segment's values at the destination. None: the segment exits. */
  readonly next: Option.Option<Values<Params, Search>>;
  readonly destination: URL;
  readonly kind: LeaveKind;
}

/** A check with its input erased. The owner check makes the erasure sound. */
export interface LeaveEntry {
  readonly ask: (
    input: LeaveInput<unknown, unknown>,
    router: RouterService,
  ) => Effect.Effect<LeaveVerdict>;
}

export interface MountedRouteService {
  /** The segment whose instance is setting up. */
  readonly owner: AnySegment;
  /** Add one check for as long as the caller's Scope lives. */
  readonly register: (entry: LeaveEntry) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * The mounted segment instance a view is setting up in. Each instance
 * provides its own to its own setup, so a child's registration never lands
 * on its layout.
 */
export class MountedRoute extends Context.Service<MountedRoute, MountedRouteService>()(
  "effect-frame/src/router/leave/MountedRoute",
) {}

/** A view registered a check for a segment that is not the one it mounts. */
export class LeaveOwnerMismatch extends Schema.TaggedError<LeaveOwnerMismatch>()(
  "LeaveOwnerMismatch",
  {
    owner: Schema.String,
    mounted: Schema.String,
  },
) {}

/**
 * Register a leave check for the mounted instance of `owner`. The owner
 * narrows the input's params and search, and proves which instance owns the
 * registration: any other owner is a defect.
 *
 * The check's services are captured here, from the view's own context. Each
 * question runs with a fresh temporary Scope (a dialog closes on every
 * result, and on interruption) and a read-only Router; the view's Scope is
 * never carried into it.
 */
export const onLeave: <Params, Search, R>(
  owner: Segment<string, Params, Search, Declarations, Declarations, unknown>,
  check: (input: LeaveInput<Params, Search>) => Effect.Effect<LeaveVerdict, never, R>,
) => Effect.Effect<void, never, MountedRoute | Scope.Scope | R> = Effect.fn("Leave.onLeave")(
  function* <Params, Search, R>(
    owner: Segment<string, Params, Search, Declarations, Declarations, unknown>,
    check: (input: LeaveInput<Params, Search>) => Effect.Effect<LeaveVerdict, never, R>,
  ) {
    const mounted = yield* MountedRoute;
    if (mounted.owner !== owner) {
      return yield* Effect.die(
        LeaveOwnerMismatch.make({ owner: owner.name, mounted: mounted.owner.name }),
      );
    }
    const captured = yield* Effect.context<R>();
    yield* mounted.register({
      ask: (input, router) =>
        check(narrow<Params, Search>(input)).pipe(
          Effect.scoped,
          Effect.provideService(Router, router),
          Effect.provideContext(captured),
        ),
    });
  },
);

/**
 * The input of the instance that registered. `onLeave` refused every other
 * owner, and that instance decoded these values with the owner's codecs.
 */
const narrow = <Params, Search>(input: LeaveInput<unknown, unknown>): LeaveInput<Params, Search> =>
  // oxlint-disable-next-line effect/noAs -- the registrar accepted only this owner's instance; see above.
  input as LeaveInput<Params, Search>;
