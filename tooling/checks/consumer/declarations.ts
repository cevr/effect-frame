import type { ActorTransport, QueryCache, TransportReadError } from "effect-frame/actor/client";
import { Source } from "effect-frame/actor/client";
import type { AnyRoute, Location, NotFoundProps } from "effect-frame/router";
import { hydrate, NavigationBehavior } from "effect-frame/router";
import type { Dom, View } from "effect-frame/view";
import { session } from "effect-frame/view/driven";
import type { Effect, Scope } from "effect";

/**
 * Types as a consumer installs them. Each assertion names a type that a
 * build once published as `any` or `unknown`; this file compiles against
 * `dist` only, so a widened declaration fails it. Each input carries a
 * requirement of its own, so a declaration that drops a generic's
 * requirements fails too.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

interface RouteService {
  readonly _tag: "RouteService";
}
interface NotFoundService {
  readonly _tag: "NotFoundService";
}
interface SessionService {
  readonly _tag: "SessionService";
}
interface ViewFailed {
  readonly _tag: "ViewFailed";
}

declare const root: Dom.DomNode;
declare const routes: ReadonlyArray<AnyRoute<RouteService>>;
declare const notFound: View.View<NotFoundProps, never, NotFoundService>;
const hydrated = hydrate({
  landing: NavigationBehavior.Restore,
  traversalReadLimit: "3 seconds",
  routes,
  notFound,
  root,
});

export const hydrateRequirements: Equals<
  Effect.Services<typeof hydrated>,
  RouteService | NotFoundService | Location | QueryCache | Scope.Scope
> = true;
export const hydrateReport: Equals<Effect.Success<typeof hydrated>["report"], Dom.HydrationReport> =
  true;

declare const sessionView: View.View<{ readonly room: string }, ViewFailed, SessionService>;
declare const drive: Parameters<typeof session>[2];
const opened = session(sessionView, { room: "a" }, drive);

export const sessionError: Equals<
  Effect.Error<typeof opened>,
  ViewFailed | TransportReadError
> = true;
export const sessionRequirements: Equals<
  Effect.Services<typeof opened>,
  SessionService | ActorTransport | Scope.Scope
> = true;

// An `any` select would make the result `any`, which `Equals` tells apart.
declare const titles: Source<string>;
const lengths = Source.select(titles, (title) => title.length);
export const selectProjects: Equals<typeof lengths, Source<number>> = true;
