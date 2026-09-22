import type { Duration } from "effect";
import { Effect, Option, Predicate } from "effect";
import type { Lifecycle, OwnedCommand, Terminal } from "./command-owner.js";
import type { Committed } from "./engine-types.js";
import { select } from "./source.js";
import type { Source } from "./source.js";
import type {
  Applied,
  CommandAdmitted,
  CommandApplied,
  CommandId,
  CommandRejected,
  CommandSent,
  CommandUncertain,
  DurableSendOptions,
} from "./vocabulary.js";
import { committedRevision, Uncertain } from "./vocabulary.js";

/** The public lifecycle of an identified command with this rejection set. */
export type PublicLifecycle<State, Rejection> =
  | CommandSent
  | CommandAdmitted
  | CommandApplied<State>
  | CommandRejected<Rejection>
  | CommandUncertain;

export type PublicTerminal<State, Rejection> = CommandApplied<State> | CommandRejected<Rejection>;

/** The caller's command ID, when one was given. Omitted options mean fresh. */
export const suppliedId = (options: DurableSendOptions | void): Option.Option<CommandId> => {
  // The public option is `void` when omitted; only this comparison narrows it.
  // oxlint-disable-next-line effect/noNullish -- `void` option at the public boundary
  if (options === undefined) {
    return Option.none();
  }
  return Option.fromNullishOr(options.commandId);
};

/** The public committed value. Only the committed clock becomes a revision. */
export const toApplied = <State>(committed: Committed<State>): Applied<State> => ({
  revision: committedRevision(committed.revision),
  state: committed.state,
});

const toTerminal = <State, Rejection>(
  terminal: Terminal<State, Rejection>,
): PublicTerminal<State, Rejection> => {
  if (terminal._tag === "Rejected") {
    return terminal;
  }
  return {
    _tag: "Applied",
    admitted: terminal.admitted,
    revision: committedRevision(terminal.committed.revision),
    state: terminal.committed.state,
  };
};

const isTerminal = Predicate.or(Predicate.isTagged("Applied"), Predicate.isTagged("Rejected"));

export const toPublic = <State, Rejection>(
  lifecycle: Lifecycle<State, Rejection>,
): PublicLifecycle<State, Rejection> => {
  if (isTerminal(lifecycle)) {
    return toTerminal(lifecycle);
  }
  return lifecycle;
};

/** One identified handle before its placement names the rejection set. */
export interface IdentifiedView<State, Rejection> {
  readonly commandId: CommandId;
  readonly state: Source<PublicLifecycle<State, Rejection>>;
  readonly settled: Effect.Effect<PublicTerminal<State, Rejection>>;
  readonly retry: Effect.Effect<void>;
}

/** The public identified handle over one owned command. */
export const identifiedHandle = <State, Rejection>(
  owned: OwnedCommand<State, Rejection>,
): IdentifiedView<State, Rejection> => ({
  commandId: owned.commandId,
  state: select(owned.lifecycle, (lifecycle) => toPublic(lifecycle)),
  settled: Effect.map(owned.settled, (terminal) => toTerminal(terminal)),
  retry: owned.retry,
});

const terminalOf = <State, Rejection>(
  lifecycle: Lifecycle<State, Rejection>,
): Option.Option<Terminal<State, Rejection>> => {
  if (isTerminal(lifecycle)) {
    return Option.some(lifecycle);
  }
  return Option.none();
};

/**
 * One `call`: submit through the owner and wait for the first terminal state
 * inside the caller's timeout. Encoding runs inside that timeout too. The
 * owner keeps its sequence when the wait ends; `Uncertain` means the wait
 * ended, not that the command failed. A closing owner ends the wait with
 * the handle's last state, so a waiter never outlives its reference.
 */
export const callThrough = <State, Rejection>(
  submit: Effect.Effect<OwnedCommand<State, Rejection>>,
  commandId: CommandId,
  timeout: Duration.Input,
  ownerClosed: Effect.Effect<void>,
): Effect.Effect<Applied<State>, Rejection | Uncertain> =>
  Effect.gen(function* () {
    const wait = Effect.flatMap(submit, (owned) =>
      Effect.raceFirst(
        Effect.map(owned.settled, Option.some),
        Effect.andThen(ownerClosed, Effect.map(owned.lifecycle.get, terminalOf)),
      ),
    );
    const waited = Option.flatten(yield* Effect.timeoutOption(wait, timeout));
    if (Option.isNone(waited)) {
      return yield* Uncertain.make({ commandId });
    }
    const terminal = waited.value;
    if (terminal._tag === "Rejected") {
      return yield* Effect.fail(terminal.reason);
    }
    return toApplied(terminal.committed);
  });
