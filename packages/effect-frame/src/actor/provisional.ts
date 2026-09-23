import type { Scope } from "effect";
import { Effect, Option, Stream, SubscriptionRef } from "effect";
import type { Committed } from "./engine-types.js";
import type { Source } from "./source.js";
import type { CommandId, Displayed } from "./vocabulary.js";
import { committedRevision } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// The pending log (#19, #67)
// ---------------------------------------------------------------------------

/**
 * One exact receipt: the admission position of a command and the revision
 * that command committed. The mailbox is serial, so it also orders every
 * other admission of the same actor against that revision.
 */
interface Anchor {
  readonly admitted: number;
  readonly revision: number;
}

/** One predicted command that the committed base does not hold yet. */
interface Overlay<State, Message> {
  readonly commandId: CommandId;
  readonly message: Message;
  /** Its admission position, once a send reply reported it. */
  readonly admitted: Option.Option<number>;
  /**
   * The exact committed result its own receipt carried. It is also a
   * candidate base: evidence that arrives later can classify it.
   */
  readonly exact: Option.Option<Committed<State>>;
}

/**
 * The display of one reference. `overlays` holds exactly the predicted
 * commands the base does not hold, in send order. The shown state is the
 * base with those overlays applied, so a command leaves the display only by
 * leaving the log: a rollback is not an operation.
 */
interface Log<State, Message> {
  readonly base: Committed<State>;
  /** The newest committed state that could not be classified yet. */
  readonly held: Option.Option<Committed<State>>;
  readonly overlays: ReadonlyArray<Overlay<State, Message>>;
  /** The receipt with the greatest admission position this reference saw. */
  readonly anchor: Option.Option<Anchor>;
  readonly shown: Displayed<State>;
}

type Membership = "Included" | "Excluded" | "Unknown";

/**
 * Whether a committed revision holds one predicted command. Its own receipt
 * decides by revision alone. Otherwise the newest anchor decides by
 * admission order:
 *
 * - The anchor is newer than the revision: every admission at or after the
 *   anchor's is absent. An earlier admission is unknown.
 * - Otherwise every admission at or before the anchor's is present. At the
 *   anchor's own revision, a later admission is absent. After it, unknown.
 *
 * An admission this client has not seen is unknown.
 */
const membership = <State, Message>(
  overlay: Overlay<State, Message>,
  revision: number,
  anchor: Option.Option<Anchor>,
): Membership => {
  if (Option.isSome(overlay.exact)) {
    if (overlay.exact.value.revision <= revision) {
      return "Included";
    }
    return "Excluded";
  }
  if (Option.isNone(overlay.admitted) || Option.isNone(anchor)) {
    return "Unknown";
  }
  const admitted = overlay.admitted.value;
  const known = anchor.value;
  if (known.revision > revision) {
    if (admitted >= known.admitted) {
      return "Excluded";
    }
    return "Unknown";
  }
  if (admitted <= known.admitted) {
    return "Included";
  }
  if (known.revision === revision) {
    return "Excluded";
  }
  return "Unknown";
};

const show = <State, Message>(
  base: Committed<State>,
  overlays: ReadonlyArray<Overlay<State, Message>>,
  predict: (state: State, message: Message) => State,
): Displayed<State> => {
  if (overlays.length === 0) {
    return { revision: committedRevision(base.revision), state: base.state };
  }
  return {
    revision: { _tag: "Provisional", base: base.revision, depth: overlays.length },
    state: overlays.reduce((state, overlay) => predict(state, overlay.message), base.state),
  };
};

const greatest = <State>(
  held: Option.Option<Committed<State>>,
  candidate: Committed<State>,
): Committed<State> =>
  Option.match(held, {
    onNone: () => candidate,
    onSome: (current) => {
      if (current.revision > candidate.revision) {
        return current;
      }
      return candidate;
    },
  });

/**
 * Offers one committed state. It becomes the base only when it is newer and
 * every overlay's membership in it is known; then the overlays it holds
 * leave and the rest replay over it. Otherwise it is held, and the display
 * keeps its last coherent value until later evidence classifies it.
 */
const offer = <State, Message>(
  log: Log<State, Message>,
  candidate: Committed<State>,
  predict: (state: State, message: Message) => State,
): Log<State, Message> => {
  if (candidate.revision <= log.base.revision) {
    return log;
  }
  const memberships = log.overlays.map((overlay) =>
    membership(overlay, candidate.revision, log.anchor),
  );
  if (memberships.includes("Unknown")) {
    return { ...log, held: Option.some(greatest(log.held, candidate)) };
  }
  const overlays = log.overlays.filter((_, index) => memberships[index] === "Excluded");
  const advanced: Log<State, Message> = {
    ...log,
    base: candidate,
    held: Option.none(),
    overlays,
    shown: show(candidate, overlays, predict),
  };
  // A newer held state may be classifiable over the new base.
  return Option.match(log.held, {
    onNone: () => advanced,
    onSome: (held) => offer(advanced, held, predict),
  });
};

/**
 * Offers every retained candidate again after new evidence: the held state
 * and each overlay's own receipt, newest first. A newer candidate that stays
 * unknown is held, and an older one that is now known can still advance the
 * base under it.
 */
const reoffer = <State, Message>(
  log: Log<State, Message>,
  predict: (state: State, message: Message) => State,
): Log<State, Message> => {
  const candidates = [
    ...Option.toArray(log.held),
    ...log.overlays.flatMap((overlay) => Option.toArray(overlay.exact)),
  ].toSorted((left, right) => right.revision - left.revision);
  return candidates.reduce((current, candidate) => offer(current, candidate, predict), {
    ...log,
    held: Option.none<Committed<State>>(),
  });
};

const updateOverlay = <State, Message>(
  log: Log<State, Message>,
  commandId: CommandId,
  update: (overlay: Overlay<State, Message>) => Overlay<State, Message>,
): Log<State, Message> => ({
  ...log,
  overlays: log.overlays.map((overlay) => {
    if (overlay.commandId === commandId) {
      return update(overlay);
    }
    return overlay;
  }),
});

/** Drops every overlay whose own receipt the base already holds. */
const incorporate = <State, Message>(
  log: Log<State, Message>,
  predict: (state: State, message: Message) => State,
): Log<State, Message> => {
  const overlays = log.overlays.filter(
    (overlay) => membership(overlay, log.base.revision, Option.none()) !== "Included",
  );
  if (overlays.length === log.overlays.length) {
    return log;
  }
  return { ...log, overlays, shown: show(log.base, overlays, predict) };
};

// ---------------------------------------------------------------------------
// The display a remote reference owns
// ---------------------------------------------------------------------------

/**
 * The displayed value of one remote reference and the only place that
 * applies predictions. Every change is one serialized update of the log.
 */
export interface Display<State, Message> {
  readonly displayed: Source<Displayed<State>>;
  /** Offers a committed state from the change stream or a receipt. */
  readonly offer: (committed: Committed<State>) => Effect.Effect<void>;
  /**
   * Registers one predicted command in the current Scope. It shows at once.
   * Closing the Scope removes it, unless its own receipt already arrived:
   * then it stays until the base holds it.
   */
  readonly predict: (
    commandId: CommandId,
    message: Message,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** A send reply reported this admission position. */
  readonly admit: (commandId: CommandId, admitted: number) => Effect.Effect<void>;
  /**
   * One command's own receipt: its admission position and its commit. It is
   * evidence only; the committed state still goes through `offer`.
   */
  readonly receipt: (
    commandId: CommandId,
    admitted: Option.Option<number>,
    committed: Committed<State>,
  ) => Effect.Effect<void>;
}

export const make = <State, Message>(
  initial: Committed<State>,
  predict: (state: State, message: Message) => State,
): Effect.Effect<Display<State, Message>> =>
  Effect.map(
    SubscriptionRef.make<Log<State, Message>>({
      base: initial,
      held: Option.none(),
      overlays: [],
      anchor: Option.none(),
      shown: show(initial, [], predict),
    }),
    (log): Display<State, Message> => {
      const update = (step: (current: Log<State, Message>) => Log<State, Message>) =>
        SubscriptionRef.update(log, step);
      return {
        // Evidence that moves nothing keeps the same shown value, so a view
        // sees one change per displayed value and none per bookkeeping step.
        displayed: {
          get: Effect.map(SubscriptionRef.get(log), (current) => current.shown),
          changes: Stream.changesWith(
            Stream.map(SubscriptionRef.changes(log), (current) => current.shown),
            (left, right) => left === right,
          ),
        },
        offer: (committed) => update((current) => offer(current, committed, predict)),
        predict: (commandId, message) =>
          Effect.acquireRelease(
            // A command sent after the base was read cannot be in it.
            update((current) => {
              const overlays = [
                ...current.overlays,
                { commandId, message, admitted: Option.none(), exact: Option.none() },
              ];
              return { ...current, overlays, shown: show(current.base, overlays, predict) };
            }),
            () =>
              update((current) => {
                const overlays = current.overlays.filter(
                  (overlay) => overlay.commandId !== commandId || Option.isSome(overlay.exact),
                );
                if (overlays.length === current.overlays.length) {
                  return current;
                }
                // It left without a receipt: rejected, or its reference
                // closed. The rest replays over the same base.
                return reoffer(
                  { ...current, overlays, shown: show(current.base, overlays, predict) },
                  predict,
                );
              }),
          ),
        admit: (commandId, admitted) =>
          update((current) =>
            reoffer(
              updateOverlay(current, commandId, (overlay) => ({
                ...overlay,
                admitted: Option.some(admitted),
              })),
              predict,
            ),
          ),
        receipt: (commandId, admitted, committed) =>
          update((current) => {
            const anchored = Option.match(admitted, {
              onNone: () => current.anchor,
              onSome: (position) => {
                const next = Option.some({ admitted: position, revision: committed.revision });
                return Option.match(current.anchor, {
                  onNone: () => next,
                  onSome: (known) => {
                    if (known.admitted >= position) {
                      return current.anchor;
                    }
                    return next;
                  },
                });
              },
            });
            const recorded = updateOverlay(
              { ...current, anchor: anchored },
              commandId,
              (overlay) => ({
                ...overlay,
                admitted: Option.orElse(admitted, () => overlay.admitted),
                exact: Option.some(committed),
              }),
            );
            // The reference offers the committed state itself as it observes
            // it. The new evidence can also classify what is retained.
            return reoffer(incorporate(recorded, predict), predict);
          }),
      };
    },
  );
