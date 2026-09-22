import { Context, Deferred, Effect, Exit, Option, Schema } from "effect";
import type { View } from "./view.js";

/**
 * PRIVATE (route slice 4). A view whose code is imported on first use. Not
 * exported from `effect-frame/view`. See `docs/design/route-pending.md`.
 *
 * `lazy(load)` returns a View with the same Props and R as the imported
 * view, and one more typed error: `LazyImportFailed`. It imports only view
 * code. A route's matching, checks, and data stay available before the
 * import, so a protected child never starts its import before its parent's
 * check continued.
 *
 * One definition shares one import while it is in flight, and keeps the
 * module once it loaded. It keeps nothing else: no request context, no view
 * result, no Scope, and no error. A rejected import lets the next attempt
 * import again. Each live instance runs the imported view's own setup, with
 * its own props and Scope.
 *
 * A waiter that is interrupted loses its right to continue. The platform
 * import is not canceled: it runs to completion on a detached fiber and, if
 * it succeeds, the module is kept for the next instance.
 */

/** The typed error a lazy view adds to its `E`. */
export class LazyImportFailed extends Schema.TaggedError<LazyImportFailed>()("LazyImportFailed", {
  message: Schema.String,
}) {}

/** What an import resolves to: a module whose default export is the view. */
export interface Module<P, E, R> {
  readonly default: View<P, E, R>;
}

/**
 * One attempt of one definition. A transition takes it after its checks
 * continued, so the import runs beside declaration acquisition, and hands
 * it to the instance's setup. The setup waits on this attempt instead of
 * starting another, so one navigation never imports twice.
 */
export interface Ticket {
  readonly token: object;
  readonly done: Deferred.Deferred<void, LazyImportFailed>;
}

/** What a transition may do with a lazy view before its setup runs. */
export interface Definition {
  readonly token: object;
  /** Join the import in flight, reuse the loaded module, or start an import. */
  readonly start: Effect.Effect<Ticket>;
}

type State<P, E, R> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly done: Deferred.Deferred<void, LazyImportFailed> }
  | {
      readonly _tag: "Loaded";
      readonly view: View<P, E, R>;
      readonly done: Deferred.Deferred<void, LazyImportFailed>;
    };

/**
 * The attempts a transition handed to this setup, by definition token.
 * A reference, so reading it adds nothing to a view's `R`.
 */
const Tickets = Context.Reference<ReadonlyMap<object, Deferred.Deferred<void, LazyImportFailed>>>(
  "effect-frame/src/view/lazy/Tickets",
  { defaultValue: () => new Map() },
);

const definitions = new WeakMap<object, Definition>();

const describe = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
};

export const lazy = <P, E, R>(
  load: () => Promise<Module<P, E, R>>,
): View<P, E | LazyImportFailed, R> => {
  const token = {};
  let state: State<P, E, R> = { _tag: "Idle" };

  /**
   * Run the platform import once, detached from every waiter. The module is
   * kept before any waiter resumes; a failure returns the definition to
   * `Idle` before any waiter resumes, so no error outlives its attempt.
   */
  const run = (done: Deferred.Deferred<void, LazyImportFailed>) =>
    Effect.tryPromise({
      try: load,
      catch: (cause) => LazyImportFailed.make({ message: describe(cause) }),
    }).pipe(
      Effect.onExit((exit) =>
        Effect.andThen(
          Effect.sync(() => {
            state = Exit.match(exit, {
              onSuccess: (module): State<P, E, R> => ({
                _tag: "Loaded",
                view: module.default,
                done,
              }),
              onFailure: (): State<P, E, R> => ({ _tag: "Idle" }),
            });
          }),
          Deferred.done(done, Exit.asVoid(exit)),
        ),
      ),
    );

  const start: Effect.Effect<Ticket> = Effect.suspend(() => {
    if (state._tag !== "Idle") {
      return Effect.succeed({ token, done: state.done });
    }
    const done = Deferred.makeUnsafe<void, LazyImportFailed>();
    state = { _tag: "Loading", done };
    return Effect.as(Effect.forkDetach(Effect.ignore(run(done))), { token, done });
  });

  const loaded: Effect.Effect<View<P, E, R>> = Effect.suspend(() => {
    if (state._tag === "Loaded") {
      return Effect.succeed(state.view);
    }
    return Effect.die(`lazy view resumed before its module loaded (${state._tag})`);
  });

  const view: View<P, E | LazyImportFailed, R> = (props) =>
    Effect.gen(function* () {
      const tickets = yield* Tickets;
      const handed = Option.fromNullishOr(tickets.get(token));
      const done = yield* Option.match(handed, {
        onNone: () => Effect.map(start, (ticket) => ticket.done),
        onSome: Effect.succeed,
      });
      yield* Deferred.await(done);
      const imported = yield* loaded;
      return yield* imported(props);
    });

  definitions.set(view, { token, start });
  return view;
};

/** The lazy definition behind a view, when it is one. */
export const definitionOf = <P, E, R>(view: View<P, E, R>): Option.Option<Definition> =>
  Option.fromNullishOr(definitions.get(view));

/** Run a setup with the attempt a transition took for it. */
export const withTicket = <A, E, R>(
  ticket: Option.Option<Ticket>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Option.match(ticket, {
    onNone: () => effect,
    onSome: (taken) =>
      Effect.flatMap(Effect.service(Tickets), (current) =>
        Effect.provideService(effect, Tickets, new Map(current).set(taken.token, taken.done)),
      ),
  });
