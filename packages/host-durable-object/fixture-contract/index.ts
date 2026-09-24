import { Clock, Duration, Effect, Layer, Option, Schema } from "effect";
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
 * `Counter` proves that committed state and command receipts survive a
 * kill. `Upload` proves that machine work survives it: its `Uploading` task
 * sleeps for a duration the state carries, so a kill during the sleep is a
 * kill during machine work, and the restart must run the task again and
 * commit its own `Done` transition once a request wakes the object.
 *
 * `Job` and `Reminder` name a wake (`Behavior.wakeAt`, #101 §5), so they
 * need no request at all. `Job` is work in flight: its steps continue after
 * a kill with no client attached. `Reminder` is a deadline: it fires at the
 * time its state holds, even when that time passed while the node was down.
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
// Job: work in flight, with no client attached
// ---------------------------------------------------------------------------

export const JobState = State({
  Idle: {},
  Running: { done: Schema.Finite, total: Schema.Finite, stepMillis: Schema.Finite },
  Finished: { total: Schema.Finite },
});

export const JobEvent = Event({
  Start: { total: Schema.Finite, stepMillis: Schema.Finite },
  Stepped: {},
});

/**
 * Each step sleeps, then commits one unit of progress as its own revision.
 * A restart hydrates the last committed step and runs the next one: the
 * work already committed is not done again.
 */
const jobMachine = Machine.make({
  state: JobState,
  event: JobEvent,
  initial: JobState.Idle,
})
  .on(JobState.Idle, JobEvent.Start, ({ event }) =>
    JobState.Running({ done: 0, total: event.total, stepMillis: event.stepMillis }),
  )
  .reenter(JobState.Running, JobEvent.Stepped, ({ state }) => {
    if (state.done + 1 >= state.total) {
      return JobState.Finished({ total: state.total });
    }
    return JobState.Running({ ...state, done: state.done + 1 });
  })
  .task(JobState.Running, ({ state }) => Effect.sleep(Duration.millis(state.stepMillis)), {
    onSuccess: () => JobEvent.Stepped,
    onFailure: () => JobEvent.Stepped,
  });

export const Job = contract("Job", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: jobMachine.stateSchema,
  message: jobMachine.eventSchema,
});

const JobLive = implement(Job, {
  behavior: Behavior.machine(jobMachine, {
    // Running is work in flight: due now, so the host keeps it running.
    wakeAt: (state) => {
      if (state._tag === "Running") {
        return Option.some(0);
      }
      return Option.none();
    },
  }),
  state: Schema.fromJsonString(jobMachine.stateSchema),
  snapshot: (state) => state,
});

// ---------------------------------------------------------------------------
// Reminder: a deadline the state holds
// ---------------------------------------------------------------------------

export const ReminderState = State({
  Idle: {},
  Scheduled: { at: Schema.Finite },
  Fired: { at: Schema.Finite, firedAt: Schema.Finite },
});

export const ReminderEvent = Event({
  Schedule: { at: Schema.Finite },
  Due: { firedAt: Schema.Finite },
});

/**
 * Sleeps until the time the state holds, then reports when it woke. The log
 * line carries that time to a proof that cannot read the runtime's disk; the
 * host's own `FrameHost.wake settled` line shows the commit.
 */
const until = (at: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.andThen(
      Effect.sleep(Duration.millis(Math.max(0, at - now))),
      Effect.tap(Clock.currentTimeMillis, (firedAt) =>
        Effect.log(`fixture.reminder at=${at} firedAt=${firedAt}`),
      ),
    ),
  );

const reminderMachine = Machine.make({
  state: ReminderState,
  event: ReminderEvent,
  initial: ReminderState.Idle,
})
  .on(ReminderState.Idle, ReminderEvent.Schedule, ({ event }) =>
    ReminderState.Scheduled({ at: event.at }),
  )
  .on(ReminderState.Scheduled, ReminderEvent.Due, ({ state, event }) =>
    ReminderState.Fired({ at: state.at, firedAt: event.firedAt }),
  )
  .task(ReminderState.Scheduled, ({ state }) => until(state.at), {
    onSuccess: (firedAt) => ReminderEvent.Due({ firedAt }),
    onFailure: () => ReminderEvent.Due({ firedAt: -1 }),
  });

export const Reminder = contract("Reminder", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: reminderMachine.stateSchema,
  message: reminderMachine.eventSchema,
});

const ReminderLive = implement(Reminder, {
  behavior: Behavior.machine(reminderMachine, {
    wakeAt: (state) => {
      if (state._tag === "Scheduled") {
        return Option.some(state.at);
      }
      return Option.none();
    },
  }),
  state: Schema.fromJsonString(reminderMachine.stateSchema),
  snapshot: (state) => state,
});

// ---------------------------------------------------------------------------
// The Durable Object and the worker
// ---------------------------------------------------------------------------

export const FrameHost = defineFrameHost({
  implementations: [CounterLive, UploadLive, JobLive, ReminderLive],
  layer: Layer.succeed(Policies, Policies.of({ public: Policy.allowAll })),
  principal: HttpServer.anonymous,
  pollInterval: Option.some("20 millis"),
  // Short, so the proof job runs across several holds and their re-arms.
  alarmHold: Option.some("2 seconds"),
});

interface Env {
  readonly HOST: DurableObjectNamespace<unknown>;
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => route(env.HOST)(request),
};
