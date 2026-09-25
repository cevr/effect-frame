import type { Source } from "effect-frame/actor";
import type { AnyContract } from "effect-frame/actor/client";
import { ActorTransport } from "effect-frame/actor/client";
import type { Host, Node, View } from "effect-frame/view";
import { Dom, Remote } from "effect-frame/view";
import type { Duration, Scope } from "effect";
import {
  Context,
  Effect,
  Equal,
  FiberSet,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { drivenContainer } from "../view/boundary-mark.js";
import { driveOnly } from "../view/drive-transport.js";
import type { LocationService } from "./router.js";
import { Location, SettledRequest } from "./router.js";

/**
 * A server-driven leaf (#18 §6, #22 §5, #27). See
 * `docs/design/driven-route.md`.
 *
 * A driven leaf draws its view into one container element. The server's
 * document draws the view there, over the drive actor, like any other
 * drawing. The client's page draws the container only: `Dom.hydrate` leaves
 * the container's children alone, and the op wire adopts them when it opens.
 * The wire opens once the document is over, that is once the record channel
 * has ended and hydration is done (#22 §5), and never before. From then on,
 * the server's session holds the tree, and the client only applies patches.
 *
 * The view is drawn on the server's recorder and on the client's, from the
 * drive's snapshot, so it may need nothing but the drive's transport and its
 * own Scope. A view that needs any other service is a client-only view, and
 * a driven leaf refuses it (`DrivenServices`).
 */

/** Everything a driven view may need: its drive's transport and its own Scope. */
export type DrivenServices = ActorTransport | Scope.Scope;

/** What a driven leaf draws, and from which actor. */
export interface DrivenOptions<Params, C extends AnyContract, E = never> {
  /** The actor whose snapshot draws the view, from the leaf's params. */
  readonly drive: (params: Params) => Remote.Drive<C>;
  /**
   * The view, drawn from its props and its drive's snapshot, and nothing
   * else. Its props are the leaf's params. A view that needs a service other
   * than `DrivenServices` does not compile: it is a client-only view. A
   * view that can fail makes its leaf name an `errored` view, as any leaf.
   */
  readonly view: View.View<Params, E, DrivenServices>;
}

/** What a driven leaf's view receives from its segment: its params. */
export interface DrivenProps<Params> {
  readonly params: Source<Params>;
}

/**
 * A driven leaf's view: `Route.drivenView` makes one, and only it. It is
 * callable as a view and tagged with what it draws, so `Route.driven` reads
 * the drive off the value a leaf was given. A view wrapped around a
 * `DrivenView` is a plain view, and `Route.driven` refuses its leaf.
 */
export interface DrivenView<Params, E = never> {
  (props: DrivenProps<Params>): Effect.Effect<Node, E, ActorTransport | Location | Scope.Scope>;
  readonly _tag: "DrivenView";
  /** The drive and the view it draws, with the params and failure erased. */
  readonly driven: ErasedDriven;
}

/**
 * What a driven view draws, with its params erased: only the params its own
 * segment decodes reach `drive` and `view`. Its failure is erased too: the
 * server end of a session reads it as a defect, and the leaf's own document
 * drawing keeps the typed failure for its `errored` view.
 */
export type ErasedDriven = DrivenOptions<never, AnyContract>;

/** Any view, as a leaf holds it: a function of its props. */
type AnyView = (props: never) => unknown;

const isDrivenView = (
  view: AnyView,
): view is AnyView & Pick<DrivenView<never>, "_tag" | "driven"> =>
  Predicate.hasProperty(view, "_tag") && view._tag === "DrivenView";

/** The options of a driven view, or None for any other view. */
export const drivenOf = (view: AnyView): Option.Option<ErasedDriven> => {
  if (isDrivenView(view)) {
    return Option.some(view.driven);
  }
  return Option.none();
};

/**
 * A driven leaf's `errored` view, when its view failed on the server, drawn
 * inside the container. The client's view draws the container and never
 * fails, so hydration keeps the server's fallback; a wire that later adopts
 * the container replaces it.
 */
export const drivenShell = (failed: Node): Node => (
  <div {...{ [drivenContainer]: "" }}>{failed}</div>
);

/** The connection to the op wire failed or was cut. The leaf resumes from a new session. */
export class WireFailed extends Schema.TaggedError<WireFailed>()("WireFailed", {
  reason: Schema.String,
}) {}

/** One session of the op wire, as the client's connection gives it. */
export interface Connection {
  /** The session's first message: `Driven.session`'s `resume`. */
  readonly resume: string;
  /** The session's patches, in order. The stream ends or fails when the connection does. */
  readonly patches: Stream.Stream<Remote.Patch, WireFailed>;
  /** Send one event to the session's `fire`. */
  readonly send: (event: Remote.RemoteEvent) => Effect.Effect<void>;
}

/**
 * How a page reaches the op wire. The page gives it to `hydrate`, which
 * opens no wire before the document is over (#22 §5); a page without it
 * keeps each driven leaf as its document drew it. The connection itself (a
 * socket, a stream) is the application's: the server end opens
 * `Driven.session` for `Route.drivenAt(routes, url)`.
 */
export interface OpWireService {
  /** Open one session for the driven leaf the page shows at `url`. */
  readonly connect: (url: URL) => Effect.Effect<Connection, WireFailed, Scope.Scope>;
  /** How long a dropped or failed connection waits before it resumes. */
  readonly reconnectAfter: Duration.Input;
}

/**
 * The op wire as `hydrate` hands it to the driven leaves: the application's
 * wire, and `over`, which completes once the document's record channel has
 * ended and hydration is done. Only `hydrate` provides it, so no leaf can
 * connect while the document is open.
 */
export class WireGate extends Context.Service<
  WireGate,
  { readonly wire: OpWireService; readonly over: Effect.Effect<void> }
>()("effect-frame/src/router/driven/WireGate") {}

/**
 * A host that forwards to whichever host is current. A connection adopts
 * the container's nodes through a hydrating host, then follows patches
 * through the plain one: the hydrating host skips a move to the end.
 */
const switching = (current: () => Host<Dom.DomNode>): Host<Dom.DomNode> => ({
  createElement: (tag, props) => current().createElement(tag, props),
  createText: (text) => current().createText(text),
  setProperty: (node, name, value) => current().setProperty(node, name, value),
  insert: (parent, node, anchor) => current().insert(parent, node, anchor),
  remove: (parent, node) => current().remove(parent, node),
  setText: (node, text) => current().setText(node, text),
  addEventListener: (node, name, handler) => current().addEventListener(node, name, handler),
  attach: (node, run) => current().attach(node, run),
});

/** A connection that fails before it resumes is tried this many times in a row. */
const reconnectAttempts = 10;

const isDiverged = Schema.is(Remote.Diverged);

/**
 * One connection for one drive: adopt what the container holds, then apply
 * every patch until the connection ends. A failure before the drawing is
 * adopted is the caller's to retry. Once it is adopted, the end of the
 * patches, or a patch the client refuses, ends this connection only: the
 * next one resumes from a new session's snapshot (#27). The client detaches
 * when the scope closes, so the next connection adopts the same nodes.
 */
const follow = <Params, C extends AnyContract, E>(
  options: DrivenOptions<Params, C, E>,
  params: Params,
  container: Dom.DomNode,
  wire: OpWireService,
  url: URL,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* wire.connect(url);
      // Each event's send runs in this connection's scope: when the
      // connection ends, a send still in flight ends with it.
      const runSend = yield* FiberSet.makeRuntime<never, void, never>();
      const adopting = Dom.hydrate(container);
      let current = adopting.host;
      const client = Remote.client(options.view, params, options.drive(params), {
        host: switching(() => current),
        root: container,
        send: (event) => void runSend(connection.send(event)),
      });
      yield* Effect.addFinalizer(() => client.detach);
      yield* client.resume(connection.resume);
      const report = yield* adopting.finish;
      current = Dom.host;
      yield* Effect.logDebug("route.driven.adopted").pipe(
        Effect.annotateLogs({ mismatches: report.mismatches.length, unclaimed: report.unclaimed }),
      );
      yield* Stream.runForEach(connection.patches, client.apply).pipe(
        Effect.catch((error) => Effect.logDebug("route.driven.dropped", error)),
      );
    }),
  );

/**
 * Follow one drive for as long as the leaf shows it: connect, follow, and
 * connect again after `reconnectAfter` when the connection ends. A
 * connection that fails before it is adopted is retried up to
 * `reconnectAttempts` times in a row, then the wire stops. A drawing that is
 * not the server's cannot be repaired by a patch, so `Diverged` stops the
 * wire at once. A stopped wire leaves the leaf as it shows.
 */
const followForever = <Params, C extends AnyContract, E>(
  options: DrivenOptions<Params, C, E>,
  params: Params,
  container: Dom.DomNode,
  wire: OpWireService,
  url: URL,
) =>
  follow(options, params, container, wire, url).pipe(
    Effect.retry({
      schedule: Schedule.spaced(wire.reconnectAfter),
      times: reconnectAttempts,
      while: (error) => !isDiverged(error),
    }),
    Effect.andThen(Effect.sleep(wire.reconnectAfter)),
    Effect.forever,
    Effect.catch((error) => Effect.logError("route.driven.stopped", error)),
  );

/**
 * Follow the drive the leaf's params name, and the next one when they
 * change: a new drive closes the old connection first.
 */
const followParams = <Params, C extends AnyContract, E>(
  options: DrivenOptions<Params, C, E>,
  params: Source<Params>,
  container: Dom.DomNode,
  wire: OpWireService,
  location: LocationService,
): Effect.Effect<void> =>
  params.changes.pipe(
    Stream.changesWith((before: Params, after: Params) => Equal.equals(before, after)),
    Stream.switchMap((next: Params) =>
      Stream.fromEffect(
        Effect.flatMap(location.current, (url) =>
          followForever(options, next, container, wire, url),
        ),
      ),
    ),
    Stream.runDrain,
  );

/**
 * Make a driven leaf's view. `Route.leaf(segment, Route.drivenView({ drive,
 * view }))` is a driven leaf; `Route.driven` mounts a tree of them.
 *
 * The server's document draws `view` inside the container, over a transport
 * that serves the drive and refuses every other read, as the session's does.
 * The client's page draws the container, and hands it to the op wire once
 * the document is over (see `hydrate`). A change of params follows the new
 * drive.
 */
export const drivenView = <Params, C extends AnyContract, E = never>(
  options: DrivenOptions<Params, C, E>,
): DrivenView<Params, E> => {
  const view = (
    props: DrivenProps<Params>,
  ): Effect.Effect<Node, E, ActorTransport | Location | Scope.Scope> =>
    Effect.gen(function* () {
      const params = yield* props.params.get;
      const drawnOnServer = Option.isSome(yield* SettledRequest);
      if (drawnOnServer) {
        const transport = yield* ActorTransport;
        const address = yield* Remote.addressOf(options.drive(params));
        const drawn = yield* options.view(params).pipe(
          Effect.provideService(
            ActorTransport,
            driveOnly(
              address,
              {
                snapshot: transport.snapshot(address),
                changes: (after) => transport.changes(address, after),
              },
              transport,
            ),
          ),
        );
        return <div {...{ [drivenContainer]: "" }}>{drawn}</div>;
      }
      const gate = yield* Effect.serviceOption(WireGate);
      const location = yield* Location;
      const handover = Dom.attach((container) =>
        Option.match(gate, {
          onNone: () => Effect.void,
          onSome: (opened) =>
            Effect.forkScoped(
              Effect.andThen(
                opened.over,
                followParams(options, props.params, container, opened.wire, location),
              ),
            ),
        }),
      );
      return <div {...{ [drivenContainer]: "" }} attach={handover} />;
    });
  const tagged: Pick<DrivenView<Params, E>, "_tag" | "driven"> = {
    _tag: "DrivenView",
    driven: { drive: options.drive, view: (params) => Effect.orDie(options.view(params)) },
  };
  return Object.assign(view, tagged);
};
