import { Duration, Effect, Layer, Option, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";
import {
  Behavior,
  HttpServer,
  Policies,
  Policy,
  implement,
  implementTransparent,
} from "effect-frame/actor";
import { contract } from "effect-frame/actor/client";
import { defineFrameHost } from "../src/frame-host.js";
import type { DurableObjectNamespace } from "../src/route.js";
import { route } from "../src/route.js";

/**
 * The generic-host proof fixture.
 *
 * The worker is the package's `route`: it sends
 * `/actors/:contract/:version/:key/<verb>` to one Durable Object per address
 * and rewrites the inner URL to the generic wire path, so the object serves
 * exactly what `HttpTransport` sends. Nothing in the object
 * knows about these two contracts: the class takes them as implementations.
 *
 * Two contracts prove two different things. `Counter` proves that committed
 * state and command receipts survive a kill. `Upload` proves that machine
 * work survives it: its `Uploading` task sleeps for a duration the state
 * carries, so a kill during the sleep is a kill during machine work, and the
 * restart must run the task again and commit its own `Done` transition.
 */

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

const CounterAdd = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type CounterAdd = Schema.Schema.Type<typeof CounterAdd>;
const CounterReset = Schema.TaggedStruct("Reset", {});
type CounterReset = Schema.Schema.Type<typeof CounterReset>;
type CounterMessage = CounterAdd | CounterReset;

export const Counter = contract("Counter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Union([CounterAdd, CounterReset]),
});

const reduceCounter = (state: number, message: CounterMessage): number => {
  if (message._tag === "Reset") {
    return 0;
  }
  return state + message.amount;
};

const CounterLive = implementTransparent(
  Counter,
  Behavior.reducer<number, CounterMessage>({ initial: 0, reduce: reduceCounter }),
);

// ---------------------------------------------------------------------------
// Upload: a machine whose task is real work
// ---------------------------------------------------------------------------

export const UploadState = State({
  Idle: {},
  Uploading: { file: Schema.String, millis: Schema.Finite },
  Done: { file: Schema.String },
});

export const UploadEvent = Event({
  Start: { file: Schema.String, millis: Schema.Finite },
  Finished: {},
});

/**
 * The task sleeps for the duration the state carries. The state is committed
 * before the task runs, so a restart hydrates `Uploading` and the machine
 * re-enters the task from the beginning. That re-run is what the proof
 * measures: `Done` cannot arrive sooner than one full sleep after the wake.
 */
const uploadMachine = Machine.make({
  state: UploadState,
  event: UploadEvent,
  initial: UploadState.Idle,
})
  .on(UploadState.Idle, UploadEvent.Start, ({ event }) =>
    UploadState.Uploading({ file: event.file, millis: event.millis }),
  )
  .on(UploadState.Uploading, UploadEvent.Finished, ({ state }) =>
    UploadState.Done({ file: state.file }),
  )
  .task(UploadState.Uploading, ({ state }) => Effect.sleep(Duration.millis(state.millis)), {
    onSuccess: () => UploadEvent.Finished,
    onFailure: () => UploadEvent.Finished,
  });

export const Upload = contract("Upload", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: uploadMachine.stateSchema,
  message: uploadMachine.eventSchema,
});

const UploadLive = implement(Upload, {
  behavior: Behavior.machine(uploadMachine),
  state: Schema.fromJsonString(uploadMachine.stateSchema),
  snapshot: (state) => state,
});

// ---------------------------------------------------------------------------
// The Durable Object and the worker
// ---------------------------------------------------------------------------

export const FrameHost = defineFrameHost({
  implementations: [CounterLive, UploadLive],
  layer: Layer.succeed(Policies, Policies.of({ public: Policy.allowAll })),
  principal: HttpServer.anonymous,
  pollInterval: Option.some("20 millis"),
});

interface Env {
  readonly HOST: DurableObjectNamespace<unknown>;
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => route(env.HOST)(request),
};
