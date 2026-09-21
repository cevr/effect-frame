import { Duration, Effect, Match, Option, Result, Schema, Stream } from "effect";
import type { ActorRef, Behavior } from "effect-frame/actor";
import { CommandId, MailboxStore, durable } from "effect-frame/actor";
import type { DurableStorage } from "./storage.js";
import * as StorageStore from "./storage-store.js";

// ---------------------------------------------------------------------------
// The hosted actor: a counter reducer
// ---------------------------------------------------------------------------

/** The one message the hosted counter takes. */
export class Add extends Schema.TaggedClass<Add>()("Add", {
  amount: Schema.Finite,
  /**
   * A test barrier. The behavior sleeps this long before it returns the next
   * state, which opens the window between an accepted response and a commit.
   * Only the crash fixture sets it.
   */
  delayMs: Schema.optional(Schema.Finite),
}) {}

export const CounterState = Schema.Struct({ total: Schema.Finite });
export type CounterState = Schema.Schema.Type<typeof CounterState>;

const StateCodec = Schema.fromJsonString(CounterState);
const MessageCodec = Schema.fromJsonString(Add);

const delayOf = (message: Add): Duration.Duration =>
  Option.match(Option.fromNullishOr(message.delayMs), {
    onNone: () => Duration.zero,
    onSome: (millis) => Duration.millis(millis),
  });

/**
 * Adds an amount to a total. The optional delay is a fixture barrier: it holds
 * the turn open so a kill can land after the accepted response and before the
 * commit. A library behavior would not have it.
 */
export const counter: Behavior.Behavior<CounterState, Add> = {
  initial: { total: 0 },
  open: () =>
    Effect.succeed({
      apply: Effect.fn("FrameActor.counter.apply")(function* (state: CounterState, message: Add) {
        yield* Effect.sleep(delayOf(message));
        return { total: state.total + message.amount };
      }),
      changes: Stream.empty,
    }),
};

// ---------------------------------------------------------------------------
// The hosted runtime
// ---------------------------------------------------------------------------

export interface HostedActor {
  readonly ref: ActorRef<CounterState, Add, "durable">;
  readonly pending: Effect.Effect<ReadonlyArray<CommandId>>;
  readonly latest: Effect.Effect<Option.Option<{ revision: number; state: string }>>;
}

/**
 * Builds the store over the object's storage and spawns the durable actor on
 * top of it. The caller owns the scope: closing it stops the actor, and the
 * next request builds a new one from the committed state.
 */
export const host = Effect.fn("FrameActor.host")(function* (storage: DurableStorage) {
  const store = yield* StorageStore.make(storage);
  const ref = yield* Effect.provideService(
    durable({ behavior: counter, state: StateCodec, message: MessageCodec }),
    MailboxStore,
    store,
  );
  return {
    ref,
    pending: store.pending,
    latest: store.latest,
  } satisfies HostedActor;
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

/** What one request asked the hosted actor to do. */
export type Command =
  | { readonly _tag: "Send"; readonly commandId: CommandId; readonly message: Add }
  | {
      readonly _tag: "Call";
      readonly commandId: CommandId;
      readonly message: Add;
      readonly timeout: Duration.Duration;
    }
  | { readonly _tag: "State" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Unknown"; readonly path: string };

/** The JSON body a request returns, with the HTTP status it carries. */
export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const decodeCommandId = Schema.decodeSync(CommandId);

const decodeState = Schema.decodeEffect(StateCodec);

const stateReply = Effect.fn("FrameActor.stateReply")(function* (actor: HostedActor) {
  const latest = yield* actor.latest;
  if (Option.isNone(latest)) {
    return { status: 200, body: { revision: 0, state: counter.initial } } satisfies Reply;
  }
  const state = yield* Effect.orDie(decodeState(latest.value.state));
  return { status: 200, body: { revision: latest.value.revision, state } } satisfies Reply;
});

const sendReply = Effect.fn("FrameActor.sendReply")(function* (
  actor: HostedActor,
  commandId: CommandId,
  message: Add,
) {
  const outcome = yield* Effect.result(actor.ref.send(message, { commandId }));
  return Result.match(outcome, {
    onFailure: (error): Reply => ({ status: 409, body: { error: error._tag } }),
    onSuccess: (receipt): Reply => ({
      status: 202,
      body: {
        commandId: receipt.commandId,
        admitted: receipt.admitted,
        committed: Option.getOrElse(receipt.committed, () => 0),
      },
    }),
  });
});

const callReply = Effect.fn("FrameActor.callReply")(function* (
  actor: HostedActor,
  commandId: CommandId,
  message: Add,
  timeout: Duration.Duration,
) {
  const outcome = yield* Effect.result(actor.ref.call(message, { commandId, timeout }));
  return Result.match(outcome, {
    onFailure: (error): Reply => ({ status: 409, body: { error: error._tag } }),
    onSuccess: (applied): Reply => ({
      status: 200,
      body: { revision: applied.revision, state: applied.state },
    }),
  });
});

/** Runs one decoded request against the hosted actor. */
const pendingReply = Effect.fn("FrameActor.pendingReply")(function* (actor: HostedActor) {
  const pending = yield* actor.pending;
  return { status: 200, body: { pending } } satisfies Reply;
});

/** Runs one decoded request against the hosted actor. */
export const handle = (actor: HostedActor, command: Command): Effect.Effect<Reply> =>
  Match.value(command).pipe(
    Match.tagsExhaustive({
      Send: (send) => sendReply(actor, send.commandId, send.message),
      Call: (call) => callReply(actor, call.commandId, call.message, call.timeout),
      State: () => stateReply(actor),
      Pending: () => pendingReply(actor),
      Unknown: (unknown) =>
        Effect.succeed({
          status: 404,
          body: { error: "NotFound", path: unknown.path },
        } satisfies Reply),
    }),
  );

/**
 * The JSON body a `/send` or `/call` request carries. The boundary parses it
 * once; nothing downstream sees an unparsed value.
 */
export const RequestBody = Schema.Struct({
  commandId: Schema.optional(CommandId),
  message: Schema.optional(
    Schema.Struct({
      amount: Schema.optional(Schema.Finite),
      delayMs: Schema.optional(Schema.Finite),
    }),
  ),
  timeoutMs: Schema.optional(Schema.Finite),
});
export type RequestBody = Schema.Schema.Type<typeof RequestBody>;

const decodeRequestBody = Schema.decodeUnknownEffect(RequestBody);

/** The body a request that carried nothing usable stands for. */
export const emptyBody: RequestBody = {};

/**
 * Parses the request body. A body this fixture cannot read stands for an
 * empty one, so a malformed request reaches `route` and returns a 4xx reply
 * instead of a defect. The caller passes what the HTTP boundary decoded.
 */
export const readBody = decodeRequestBody;

const amountOf = (body: RequestBody): number =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(body.message), (message) =>
      Option.fromNullishOr(message.amount),
    ),
    () => 1,
  );

const delayOfBody = (body: RequestBody): Option.Option<number> =>
  Option.flatMap(Option.fromNullishOr(body.message), (message) =>
    Option.fromNullishOr(message.delayMs),
  );

const timeoutOf = (body: RequestBody): Duration.Duration =>
  Duration.millis(Option.getOrElse(Option.fromNullishOr(body.timeoutMs), () => 5000));

const commandIdOf = (body: RequestBody): CommandId =>
  Option.getOrElse(Option.fromNullishOr(body.commandId), () => decodeCommandId("anonymous"));

/** Turns a path and a decoded body into the command the handler runs. */
export const route = (path: string, body: RequestBody): Command => {
  const amount = amountOf(body);
  const message = Option.match(delayOfBody(body), {
    onNone: () => Add.make({ amount }),
    onSome: (delayMs) => Add.make({ amount, delayMs }),
  });
  if (path === "/send") {
    return { _tag: "Send", commandId: commandIdOf(body), message };
  }
  if (path === "/call") {
    return {
      _tag: "Call",
      commandId: commandIdOf(body),
      message,
      timeout: timeoutOf(body),
    };
  }
  if (path === "/state") {
    return { _tag: "State" };
  }
  if (path === "/pending") {
    return { _tag: "Pending" };
  }
  return { _tag: "Unknown", path };
};
