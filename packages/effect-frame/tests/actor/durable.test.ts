import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Hash,
  Layer,
  Option,
  Queue,
  Schema,
  SchemaTransformation,
  Scope,
  Stream,
} from "effect";
import { Event, Machine, State } from "effect-machine";
import { TestClock } from "effect/testing";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import {
  ActorStopped,
  Behavior,
  CommandConflict,
  CommandId,
  MailboxStore,
  Refused,
  Uncertain,
  committedRevision,
  durable,
} from "effect-frame/actor";
import type { CommandSettled, DurableOptions } from "effect-frame/actor";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const counterBehavior = Behavior.reducer<number, Add>({
  initial: 0,
  reduce: (state, message) => state + message.amount,
});

const counterOptions: DurableOptions<number, Add, never> = {
  behavior: counterBehavior,
  state: Schema.fromJsonString(Schema.Finite),
  message: Schema.fromJsonString(Add),
};

const refusingCounter = Behavior.reducer<number, Add, Refused>({
  initial: 0,
  reduce: (state, message) => state + message.amount,
  refuse: (message) =>
    Option.as(
      Option.liftPredicate(message, (add) => add.amount < 0),
      Refused.make({ reason: "negative" }),
    ),
});

const slowBehavior: Behavior.Behavior<number, Add> = {
  initial: 0,
  open: () =>
    Effect.succeed({
      apply: (state, message) => Effect.sleep("1 hour").pipe(Effect.as(state + message.amount)),
      changes: Stream.empty,
    }),
};

// A machine whose work must survive a restart. The Uploading task waits on
// an external gate. Recovery re-enters Uploading and runs the task again.
const UploadState = State({
  Idle: {},
  Uploading: { file: Schema.String },
  Done: { file: Schema.String },
});

const UploadEvent = Event({
  Start: { file: Schema.String },
  Finished: {},
});

class Gate extends Context.Service<Gate, { readonly open: Effect.Effect<void> }>()(
  "effect-frame/tests/actor/durable.test/Gate",
) {}

const uploadMachine = Machine.make({
  state: UploadState,
  event: UploadEvent,
  initial: UploadState.Idle,
})
  .on(UploadState.Idle, UploadEvent.Start, ({ event }) =>
    UploadState.Uploading({ file: event.file }),
  )
  .on(UploadState.Uploading, UploadEvent.Finished, ({ state }) =>
    UploadState.Done({ file: state.file }),
  )
  .task(UploadState.Uploading, () => Effect.flatMap(Gate, (gate) => gate.open), {
    onSuccess: () => UploadEvent.Finished,
    onFailure: () => UploadEvent.Finished,
  });

const uploadOptions = {
  behavior: Behavior.machine(uploadMachine),
  state: Schema.fromJsonString(uploadMachine.stateSchema),
  message: Schema.fromJsonString(uploadMachine.eventSchema),
};

// A machine with no task: every transition is a command's.
const TallyState = State({ Counting: { count: Schema.Finite } });
const TallyEvent = Event({ Increment: {} });
const tallyMachine = Machine.make({
  state: TallyState,
  event: TallyEvent,
  initial: TallyState.Counting({ count: 0 }),
}).on(TallyState.Counting, TallyEvent.Increment, ({ state }) =>
  TallyState.Counting({ count: state.count + 1 }),
);

const gateThatNeverOpens = Effect.map(Deferred.make<void>(), (latch) =>
  Gate.of({ open: Deferred.await(latch) }),
);
const gateThatOpens = Gate.of({ open: Effect.void });

const id = Schema.decodeSync(CommandId);
const add = (amount: number): Add => ({ _tag: "Add", amount });

const withStore = it.scoped.layer(MailboxStore.layerMemory);

describe("durable actor", () => {
  withStore("a machine's echo of an older command never takes its state back", () =>
    Effect.gen(function* () {
      const tally = yield* durable({
        behavior: Behavior.machine(tallyMachine),
        state: Schema.fromJsonString(tallyMachine.stateSchema),
        message: Schema.fromJsonString(tallyMachine.eventSchema),
      });
      const seen: Array<number> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(tally.applied.changes, (applied) =>
          Effect.sync(() => {
            seen.push(applied.state.count);
          }),
        ),
      );
      yield* tally.send(TallyEvent.Increment, { commandId: id("t1") });
      yield* tally.send(TallyEvent.Increment, { commandId: id("t2") });
      const last = yield* tally.call(TallyEvent.Increment, {
        commandId: id("t3"),
        timeout: "1 second",
      });
      for (let round = 0; round < 10; round += 1) {
        yield* yieldFibers;
      }
      expect(last.state.count).toBe(3);
      expect(seen).toEqual([0, 1, 2, 3]);
      expect(Option.map(yield* (yield* MailboxStore).latest, (latest) => latest.revision)).toEqual(
        Option.some(3),
      );
    }),
  );

  it.scoped("a call returns only after the actor's state shows its commit", () =>
    Effect.gen(function* () {
      const memory = yield* Layer.build(MailboxStore.layerMemory);
      const inner = Context.get(memory, MailboxStore);
      const hold = yield* Deferred.make<void>();
      // The receipt is in the store, but the engine has not yet published it.
      const store = MailboxStore.of({
        ...inner,
        commit: (commandId, state) =>
          Effect.tap(inner.commit(commandId, state), () => Deferred.await(hold)),
      });
      const counter = yield* durable(counterOptions).pipe(
        Effect.provideService(MailboxStore, store),
      );
      const call = yield* Effect.forkScoped(
        counter.call(add(3), { commandId: id("c1"), timeout: "1 minute" }),
      );
      yield* TestClock.adjust("1 second");
      expect(Option.isSome(yield* inner.receipt(id("c1")))).toBe(true);
      expect(call.pollUnsafe()).toBeUndefined();
      expect(yield* counter.state.get).toBe(0);

      yield* Deferred.succeed(hold, void 0);
      expect(yield* Fiber.join(call)).toEqual({ revision: committedRevision(1), state: 3 });
      expect(yield* counter.state.get).toBe(3);
    }),
  );

  withStore("call commits the command and returns the applied revision", () =>
    Effect.gen(function* () {
      const counter = yield* durable(counterOptions);
      const applied = yield* counter.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(applied).toEqual({ revision: committedRevision(1), state: 3 });
      expect(yield* counter.state.get).toBe(3);
    }),
  );

  withStore("the same command ID with the same payload applies once", () =>
    Effect.gen(function* () {
      const counter = yield* durable(counterOptions);
      const first = yield* counter.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      const retry = yield* counter.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(retry).toEqual(first);
      const again = yield* counter.send(add(3), { commandId: id("c1") });
      expect(again.commandId).toBe(id("c1"));
      expect(yield* again.settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: 3,
      });
      expect(yield* counter.state.get).toBe(3);
    }),
  );

  withStore("a retry returns its older exact receipt after newer and autonomous state", () =>
    Effect.gen(function* () {
      const autonomous = yield* Queue.unbounded<number>();
      const behavior: Behavior.Behavior<number, Add> = {
        initial: 0,
        open: () =>
          Effect.succeed({
            apply: (state, message) => Effect.succeed(state + message.amount),
            changes: Stream.fromQueue(autonomous),
          }),
      };
      const counter = yield* durable({ ...counterOptions, behavior });

      const first = yield* counter.call(add(1), { commandId: id("older"), timeout: "1 second" });
      const newer = yield* counter.call(add(2), { commandId: id("newer"), timeout: "1 second" });
      expect(first).toEqual({ revision: committedRevision(1), state: 1 });
      expect(newer).toEqual({ revision: committedRevision(2), state: 3 });

      const autonomousWaiting = yield* Effect.forkScoped(
        Stream.runHead(Stream.filter(counter.state.changes, (state) => state === 99)),
      );
      yield* yieldFibers;
      yield* Queue.offer(autonomous, 99);
      const autonomousState = yield* Fiber.join(autonomousWaiting);
      expect(autonomousState).toEqual(Option.some(99));
      const retry = yield* counter.call(add(1), {
        commandId: id("older"),
        timeout: "1 second",
      });
      expect(retry).toEqual(first);
      expect(yield* counter.state.get).toBe(99);
    }),
  );

  withStore("the same command ID with a different payload is a conflict", () =>
    Effect.gen(function* () {
      const counter = yield* durable(counterOptions);
      yield* counter.call(add(3), { commandId: id("c1"), timeout: "1 second" });
      const conflicting = yield* counter.send(add(4), { commandId: id("c1") });
      expect(yield* conflicting.settled).toEqual({
        _tag: "Rejected",
        reason: CommandConflict.make({ commandId: id("c1") }),
      });
      expect(yield* counter.state.get).toBe(3);
    }),
  );

  withStore("a refused command is not admitted, and its retry is refused again", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;
      const counter = yield* durable({ ...counterOptions, behavior: refusingCounter });
      const refused = yield* counter.send(add(-1), { commandId: id("c1") });
      const expected = {
        _tag: "Rejected",
        reason: Refused.make({ reason: "negative" }),
      } satisfies CommandSettled<number, "durable", Refused>;
      expect(yield* refused.settled).toEqual(expected);
      // Nothing was appended: no pending row, no receipt, no revision.
      expect(yield* store.receipt(id("c1"))).toEqual(Option.none());
      expect(yield* store.pending).not.toContain(id("c1"));
      const retried = yield* counter.send(add(-1), { commandId: id("c1") });
      expect(yield* retried.settled).toEqual(expected);
      const failed = yield* Effect.flip(
        counter.call(add(-1), { commandId: id("c1"), timeout: "1 second" }),
      );
      expect(failed).toEqual(Refused.make({ reason: "negative" }));
      const accepted = yield* counter.call(add(2), { commandId: id("c2"), timeout: "1 second" });
      expect(accepted).toEqual({ revision: committedRevision(1), state: 2 });
    }),
  );

  withStore("a command the store already holds is answered from its record, not refused", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;
      const firstLife = yield* Scope.make();
      const before = yield* durable(counterOptions).pipe(Scope.provide(firstLife));
      const committed = yield* before.call(add(-1), { commandId: id("c1"), timeout: "1 second" });
      yield* Effect.repeat(store.receipt(id("c1")), { until: Option.isSome });
      yield* Scope.close(firstLife, Exit.void);

      // The rule now refuses these bytes, but the command was admitted
      // before it: a same-ID retry gets its receipt, never a refusal.
      const after = yield* durable({ ...counterOptions, behavior: refusingCounter });
      const retried = yield* after.call(add(-1), { commandId: id("c1"), timeout: "1 second" });
      expect(retried).toEqual(committed);
    }),
  );

  withStore("a restart restores the committed state and answers the retried command", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;

      const firstLife = yield* Scope.make();
      const before = yield* durable(counterOptions).pipe(Scope.provide(firstLife));
      yield* before.send(add(3), { commandId: id("c1") });
      yield* Effect.repeat(store.receipt(id("c1")), { until: Option.isSome });
      yield* Scope.close(firstLife, Exit.void);

      const after = yield* durable(counterOptions);
      expect(yield* after.state.get).toBe(3);
      const retried = yield* after.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(retried).toEqual({ revision: committedRevision(1), state: 3 });
      const next = yield* after.call(add(5), {
        commandId: id("c2"),
        timeout: "1 second",
      });
      expect(next).toEqual({ revision: committedRevision(2), state: 8 });
    }),
  );

  withStore("a command accepted before a restart is processed on wake", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;
      const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Add))(add(7));
      yield* store.append({ commandId: id("c1"), payload, payloadHash: Hash.string(payload) });
      expect(yield* store.pending).toEqual([id("c1")]);

      const counter = yield* durable(counterOptions);
      const applied = yield* counter.call(add(7), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(applied).toEqual({ revision: committedRevision(1), state: 7 });
      expect(yield* store.pending).toEqual([]);
    }),
  );

  withStore("a timed-out call is Uncertain and the command still commits", () =>
    Effect.gen(function* () {
      const counter = yield* durable({ ...counterOptions, behavior: slowBehavior });
      const waiting = yield* Effect.forkScoped(
        Effect.flip(counter.call(add(1), { commandId: id("c1"), timeout: "1 second" })),
      );
      yield* TestClock.adjust("1 second");
      const failure = yield* Fiber.join(waiting);
      expect(failure._tag).toBe("Uncertain");

      yield* TestClock.adjust("1 hour");
      const retried = yield* counter.call(add(1), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(retried).toEqual({ revision: committedRevision(1), state: 1 });
    }),
  );

  withStore("a call timeout covers asynchronous message encoding before admission", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;
      const encodingStarted = yield* Deferred.make<void>();
      const encodingRelease = yield* Deferred.make<void>();
      const encodingFinalized = yield* Deferred.make<void>();
      let encodes = 0;
      const message = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Finite,
          SchemaTransformation.transformEffect({
            decode: (value: string) => Effect.succeed(Number(value)),
            encode: (value: number) =>
              Effect.ensuring(
                Effect.gen(function* () {
                  encodes += 1;
                  yield* Deferred.succeed(encodingStarted, void 0);
                  yield* Deferred.await(encodingRelease);
                  return String(value);
                }),
                Deferred.succeed(encodingFinalized, void 0),
              ),
          }),
        ),
      );
      const counter = yield* durable({
        behavior: Behavior.reducer<number, number>({
          initial: 0,
          reduce: (state, amount) => state + amount,
        }),
        state: Schema.fromJsonString(Schema.Finite),
        message,
      });
      const waiting = yield* Effect.forkScoped(
        Effect.flip(
          counter.call(1, {
            commandId: id("encoder-timeout"),
            timeout: "10 millis",
          }),
        ),
      );
      yield* Deferred.await(encodingStarted);
      yield* TestClock.adjust("10 millis");
      const failure = yield* Fiber.join(waiting);

      expect(failure._tag).toBe("Uncertain");
      expect(encodes).toBe(1);
      expect(yield* Deferred.isDone(encodingFinalized)).toBe(true);
      expect(yield* store.pending).toEqual([]);
      expect(yield* store.latest).toEqual(Option.none());
    }),
  );

  withStore(
    "a stopped send refuses before message encoding and keeps a supplied ID uncertain",
    () =>
      Effect.gen(function* () {
        const life = yield* Scope.make();
        let encodes = 0;
        const message = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Finite,
            SchemaTransformation.transformEffect({
              decode: (value: string) => Effect.succeed(Number(value)),
              encode: (value: number) =>
                Effect.sync(() => {
                  encodes += 1;
                  return String(value);
                }),
            }),
          ),
        );
        const counter = yield* durable({
          behavior: Behavior.reducer<number, number>({
            initial: 0,
            reduce: (state, amount) => state + amount,
          }),
          state: Schema.fromJsonString(Schema.Finite),
          message,
        }).pipe(Scope.provide(life));
        yield* Scope.close(life, Exit.void);

        const fresh = yield* counter.send(1);
        expect(yield* fresh.settled).toEqual({ _tag: "Rejected", reason: ActorStopped.make() });
        const supplied = yield* counter.send(1, { commandId: id("stopped-before-encode") });
        expect(yield* supplied.state.get).toEqual({
          _tag: "Uncertain",
          attempt: 0,
          admitted: Option.none(),
        });
        const call = yield* Effect.flip(counter.call(1, { timeout: "1 second" }));
        expect(call).toEqual(ActorStopped.make());
        expect(encodes).toBe(0);
      }),
  );

  withStore("machine work interrupted by a restart resumes and commits its own transition", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;

      const firstLife = yield* Scope.make();
      const blocked = yield* gateThatNeverOpens;
      const before = yield* durable(uploadOptions).pipe(
        Effect.provideService(Gate, blocked),
        Scope.provide(firstLife),
      );
      const started = yield* before.call(UploadEvent.Start({ file: "a.txt" }), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(started.revision.value).toBe(1);
      expect(started.state._tag).toBe("Uploading");
      yield* Scope.close(firstLife, Exit.void);

      const after = yield* durable(uploadOptions).pipe(Effect.provideService(Gate, gateThatOpens));
      const done = yield* Stream.runHead(
        Stream.filter(after.state.changes, (state) => state._tag === "Done"),
      );
      expect(Option.map(done, (state) => state._tag)).toEqual(Option.some("Done"));
      const latest = yield* store.latest;
      expect(Option.map(latest, (committed) => committed.revision)).toEqual(Option.some(2));
      expect(yield* store.pending).toEqual([]);
    }),
  );

  withStore("a machine's initial state does not spend a revision", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;
      const upload = yield* durable(uploadOptions).pipe(Effect.provideService(Gate, gateThatOpens));
      yield* yieldFibers;
      expect(yield* store.latest).toEqual(Option.none());
      const started = yield* upload.call(UploadEvent.Start({ file: "a.txt" }), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(started.revision.value).toBe(1);
    }),
  );

  withStore("closing the scope ends a waiting call as Uncertain: the row may still commit", () =>
    Effect.gen(function* () {
      const life = yield* Scope.make();
      const counter = yield* durable({ ...counterOptions, behavior: slowBehavior }).pipe(
        Scope.provide(life),
      );
      const waiting = yield* Effect.forkScoped(
        Effect.flip(counter.call(add(1), { commandId: id("c1"), timeout: "1 minute" })),
      );
      yield* TestClock.adjust("10 millis");
      yield* Scope.close(life, Exit.void);
      const failure = yield* Fiber.join(waiting);
      expect(failure).toEqual(Uncertain.make({ commandId: id("c1") }));
    }),
  );
});
