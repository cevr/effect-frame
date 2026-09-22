import { Context, Deferred, Effect, Exit, Layer, Option, Ref, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import { ActorHost, MailboxStore, implementQuery, implementTransparent } from "effect-frame/actor";
import {
  ActorTransport,
  QueryCache,
  contract,
  query,
  queryCacheLayer,
  ref,
  useQuery,
} from "effect-frame/actor/client";
import type {
  CommandState,
  QueryEntry,
  QueryCacheService,
  QueryFailure,
  QueryState,
  TransportService,
} from "effect-frame/actor/client";
import { CommandPolicy } from "../../src/actor/command-owner.js";
import * as Frame from "../../src/frame.js";
import * as Inspection from "../../src/inspection.js";

const Counter = contract("CommandCacheCounter", {
  version: 1,
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Finite,
});

const CounterValue = query("CommandCacheCounterValue", {
  args: Schema.String,
  result: Schema.Finite,
  depends: [Counter],
});

const Unrelated = query("CommandCacheUnrelated", {
  args: Schema.String,
  result: Schema.String,
  depends: [],
});

interface ReadHold {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

/**
 * The test's hands on the real host: a gate per message amount holds that
 * message's turn, a send gate holds the admission reply, and the query
 * implementation counts its reads.
 */
class Control extends Context.Service<
  Control,
  {
    readonly gates: Map<number, Deferred.Deferred<void>>;
    readonly sendHold: Ref.Ref<Option.Option<Deferred.Deferred<void>>>;
    /** Holds a query read after it took its snapshot, before it returns. */
    readonly readHold: Ref.Ref<Option.Option<ReadHold>>;
    readonly started: Ref.Ref<ReadonlyArray<number>>;
    readonly reads: Ref.Ref<number>;
  }
>()("effect-frame/tests/actor/command-cache.test/Control") {}

const controlLayer = Layer.effect(
  Control,
  Effect.gen(function* () {
    return Control.of({
      gates: new Map(),
      sendHold: yield* Ref.make(Option.none<Deferred.Deferred<void>>()),
      readHold: yield* Ref.make(Option.none<ReadHold>()),
      started: yield* Ref.make<ReadonlyArray<number>>([]),
      reads: yield* Ref.make(0),
    });
  }),
);

const heldBehavior = {
  initial: 0,
  open: () =>
    Effect.gen(function* () {
      const control = yield* Control;
      return {
        apply: (state: number, amount: number) =>
          Effect.gen(function* () {
            yield* Ref.update(control.started, (started) => [...started, amount]);
            const gate = Option.fromNullishOr(control.gates.get(amount));
            if (Option.isSome(gate)) {
              yield* Deferred.await(gate.value);
            }
            return state + amount;
          }),
        changes: Stream.empty,
      };
    }),
};

const CounterLive = implementTransparent(Counter, heldBehavior);

const CounterValueLive = implementQuery(CounterValue, (key) =>
  Effect.gen(function* () {
    const control = yield* Control;
    yield* Ref.update(control.reads, (reads) => reads + 1);
    const transport = yield* ActorTransport;
    const projection = yield* transport.snapshot({
      contract: Counter.name,
      version: Counter.version,
      key: yield* Effect.orDie(Schema.encodeEffect(Counter.key)(key)),
    });
    const hold = yield* Ref.get(control.readHold);
    if (Option.isSome(hold)) {
      yield* Deferred.succeed(hold.value.reached, void 0);
      yield* Deferred.await(hold.value.release);
    }
    return yield* Schema.decodeEffect(Counter.snapshot)(projection.snapshot);
  }),
);

const UnrelatedLive = implementQuery(Unrelated, (key) => Effect.succeed(`unrelated:${key}`));

/** The real in-process host, with its send reply held while the test asks. */
const heldTransport = Effect.gen(function* () {
  const control = yield* Control;
  const real = yield* ActorHost.make({
    implementations: [CounterLive],
    store: () => MailboxStore.layerMemory,
    queries: [CounterValueLive, UnrelatedLive],
  });
  const transport: TransportService = {
    ...real,
    send: (address, commandId, payload, active) =>
      Effect.gen(function* () {
        const hold = yield* Ref.get(control.sendHold);
        if (Option.isSome(hold)) {
          yield* Deferred.await(hold.value);
        }
        return yield* real.send(address, commandId, payload, active);
      }),
  };
  return transport;
});

const appLayer = Layer.merge(queryCacheLayer, ActorTransport.layerLocal(heldTransport)).pipe(
  Layer.provideMerge(Frame.layer({ name: "command-cache" })),
  Layer.provideMerge(controlLayer),
);

const withApp = it.scoped.layer(appLayer);

const gate = (amount: number) =>
  Effect.gen(function* () {
    const control = yield* Control;
    const held = yield* Deferred.make<void>();
    control.gates.set(amount, held);
    return held;
  });

const startedTurns = (count: number) =>
  Effect.gen(function* () {
    const control = yield* Control;
    yield* Effect.repeat(Ref.get(control.started), {
      until: (started) => started.length >= count,
    });
  });

const reads = Effect.gen(function* () {
  const control = yield* Control;
  return yield* Ref.get(control.reads);
});

type Shown<A> = QueryState<A, QueryFailure>;

const until = <A>(entry: QueryEntry<A, QueryFailure>, done: (state: Shown<A>) => boolean) =>
  Effect.map(Stream.runHead(Stream.filter(entry.state.changes, done)), Option.getOrThrow);

const ready = <A>(value: A, stale: boolean): Shown<A> => ({ _tag: "Ready", value, stale });

/** Every state an entry shows from now on, in order. */
const recordStates = <A>(entry: QueryEntry<A, QueryFailure>) =>
  Effect.gen(function* () {
    const seen: Array<Shown<A>> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(entry.state.changes, (state) => Effect.sync(() => seen.push(state))),
    );
    yield* yieldFibers;
    return seen;
  });

const isReady =
  <A>(value: A, stale: boolean) =>
  (state: Shown<A>) =>
    state._tag === "Ready" && state.value === value && state.stale === stale;

const firstState = <State>(
  handle: { readonly state: { readonly changes: Stream.Stream<CommandState<State, "remote">> } },
  tag: CommandState<State, "remote">["_tag"],
) =>
  Effect.map(
    Stream.runHead(Stream.filter(handle.state.changes, (state) => state._tag === tag)),
    Option.getOrThrow,
  );

describe("cache command ownership", () => {
  withApp("concurrent commands keep dependents stale until the last one settles", () =>
    Effect.gen(function* () {
      const value = yield* useQuery(CounterValue, "one");
      const unrelated = yield* useQuery(Unrelated, "one");
      yield* until(value, isReady(0, false));
      yield* until(unrelated, isReady("unrelated:one", false));
      const gateA = yield* gate(1);
      const gateB = yield* gate(2);
      const counter = yield* ref(Counter, "one");

      const a = yield* counter.send(1);
      const b = yield* counter.send(2);
      expect(yield* value.state.get).toEqual(ready(0, true));
      expect(yield* unrelated.state.get).toEqual(ready("unrelated:one", false));
      yield* startedTurns(1);

      yield* Deferred.succeed(gateA, void 0);
      const settledA = yield* a.settled;
      expect(settledA._tag).toBe("Applied");
      // A's reply refreshed the entry, but B still owns it.
      expect(yield* value.state.get).toEqual(ready(1, true));

      yield* Deferred.succeed(gateB, void 0);
      const settledB = yield* b.settled;
      expect(settledB._tag).toBe("Applied");
      expect(yield* value.state.get).toEqual(ready(3, false));
      // One initial read and one captured refresh per settlement call.
      expect(yield* reads).toBe(3);
    }),
  );

  withApp("a query mounted after the command began is stale and reads again after it", () =>
    Effect.gen(function* () {
      const held = yield* gate(1);
      const counter = yield* ref(Counter, "one");
      const command = yield* counter.send(1);
      yield* startedTurns(1);

      const late = yield* useQuery(CounterValue, "one");
      expect(yield* until(late, (state) => state._tag === "Ready")).toEqual(ready(0, true));
      expect(yield* reads).toBe(1);
      const seen = yield* recordStates(late);

      yield* Deferred.succeed(held, void 0);
      expect((yield* command.settled)._tag).toBe("Applied");
      // The command's captured keys predate this entry, so its reply did not
      // cover it. The cache reads it again after settlement, and the value
      // from before the command never shows as fresh on the way.
      yield* until(late, isReady(1, false));
      expect(yield* reads).toBe(2);
      expect(seen).not.toContainEqual(ready(0, false));
      expect(seen.at(-1)).toEqual(ready(1, false));
    }),
  );

  withApp("a read in flight when the command settles lands stale and reads again", () =>
    Effect.gen(function* () {
      const control = yield* Control;
      const held = yield* gate(1);
      const counter = yield* ref(Counter, "one");
      const command = yield* counter.send(1);
      yield* startedTurns(1);

      const readHold: ReadHold = {
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      yield* Ref.set(control.readHold, Option.some(readHold));
      const late = yield* useQuery(CounterValue, "one");
      const seen = yield* recordStates(late);
      // The first read took its snapshot before the command applied.
      yield* Deferred.await(readHold.reached);
      yield* Ref.set(control.readHold, Option.none());

      yield* Deferred.succeed(held, void 0);
      expect((yield* command.settled)._tag).toBe("Applied");
      yield* yieldFibers;
      yield* Deferred.succeed(readHold.release, void 0);
      yield* until(late, isReady(1, false));
      expect(yield* reads).toBe(2);
      expect(seen).not.toContainEqual(ready(0, false));
      expect(seen.at(-1)).toEqual(ready(1, false));
    }),
  );

  withApp("a custom QueryCache without command ownership still settles commands", () =>
    Effect.gen(function* () {
      const real = yield* QueryCache;
      // A user's own cache implements only the public service.
      const custom: QueryCacheService = {
        open: real.open,
        active: real.active,
        apply: real.apply,
        invalidate: real.invalidate,
      };
      const value = yield* useQuery(CounterValue, "one");
      yield* until(value, isReady(0, false));
      const counter = yield* ref(Counter, "one").pipe(Effect.provideService(QueryCache, custom));
      const command = yield* counter.send(1);
      expect((yield* command.settled)._tag).toBe("Applied");
      // Nothing claimed the real entry, so it never showed stale for it.
      expect(yield* value.state.get).toEqual(ready(0, false));
    }),
  );

  withApp("a settlement never recreates an entry that was released", () =>
    Effect.gen(function* () {
      const cache = yield* QueryCache;
      const view = yield* Scope.make();
      const value = yield* useQuery(CounterValue, "one").pipe(Scope.provide(view));
      yield* until(value, isReady(0, false));
      const held = yield* gate(1);
      const counter = yield* ref(Counter, "one");
      const command = yield* counter.send(1);
      yield* startedTurns(1);
      yield* Scope.close(view, Exit.void);
      expect(yield* cache.active).toEqual([]);

      yield* Deferred.succeed(held, void 0);
      expect((yield* command.settled)._tag).toBe("Applied");
      yield* yieldFibers;
      expect(yield* cache.active).toEqual([]);
      // The captured key named the released entry; the server may refresh it
      // once for the reply, but no client entry comes back and no later read
      // starts.
      const after = yield* reads;
      yield* yieldFibers;
      expect(yield* reads).toBe(after);
    }),
  );

  withApp("closing the reference releases its ownership without a settlement", () =>
    Effect.gen(function* () {
      const value = yield* useQuery(CounterValue, "one");
      yield* until(value, isReady(0, false));
      yield* gate(1);
      const life = yield* Scope.make();
      const counter = yield* ref(Counter, "one").pipe(Scope.provide(life));
      const command = yield* counter.send(1);
      yield* startedTurns(1);
      expect(yield* value.state.get).toEqual(ready(0, true));

      yield* Scope.close(life, Exit.void);
      expect(yield* value.state.get).toEqual(ready(0, false));
      // The handle keeps its last honest state; closure is not a refusal.
      expect((yield* command.state.get)._tag).toBe("Admitted");
      expect((yield* Frame.inspect).commands).toEqual({ _tag: "Available", records: [] });
    }),
  );

  withApp("an exhausted command keeps ownership until its manual retry applies", () =>
    Effect.gen(function* () {
      const value = yield* useQuery(CounterValue, "one");
      yield* until(value, isReady(0, false));
      const held = yield* gate(1);
      const counter = yield* ref(Counter, "one").pipe(
        Effect.provideService(CommandPolicy, {
          passes: 1,
          passDeadline: "1 second",
          baseDelay: "10 millis",
          maxDelay: "10 millis",
        }),
      );
      const command = yield* counter.send(1);
      yield* startedTurns(1);
      yield* TestClock.adjust("1 second");
      const exhausted = yield* firstState(command, "Uncertain");
      expect(exhausted).toEqual({ _tag: "Uncertain", attempt: 1, admitted: Option.some(1) });
      expect(yield* value.state.get).toEqual(ready(0, true));
      expect((yield* Frame.inspect).commands).toEqual({
        _tag: "Available",
        records: [
          expect.objectContaining({
            kind: "remote",
            commandId: command.commandId,
            identity: "fresh",
            attempt: 1,
            running: false,
            lifecycle: { _tag: "Uncertain", attempt: 1, admitted: 1 },
          }),
        ],
      });

      yield* Deferred.succeed(held, void 0);
      yield* command.retry;
      expect((yield* command.settled)._tag).toBe("Applied");
      expect(yield* value.state.get).toEqual(ready(1, false));
      expect((yield* Frame.inspect).commands).toEqual({ _tag: "Available", records: [] });
    }),
  );
});

describe("Frame command inspection", () => {
  withApp("samples held Sent and Admitted remote commands without doing their work", () =>
    Effect.gen(function* () {
      const control = yield* Control;
      const sendHold = yield* Deferred.make<void>();
      yield* Ref.set(control.sendHold, Option.some(sendHold));
      const held = yield* gate(1);
      const counter = yield* ref(Counter, "one");
      const command = yield* counter.send(1);
      yield* yieldFibers;

      const sent = yield* Frame.inspect;
      expect(sent.commands).toEqual({
        _tag: "Available",
        records: [
          expect.objectContaining({
            _tag: "Command",
            kind: "remote",
            commandId: command.commandId,
            identity: "fresh",
            attempt: 1,
            running: true,
            lifecycle: { _tag: "Sent" },
          }),
        ],
      });
      expect(yield* Ref.get(control.started)).toEqual([]);
      expect(Schema.is(Frame.Snapshot)(sent)).toBe(true);

      yield* Ref.set(control.sendHold, Option.none());
      yield* Deferred.succeed(sendHold, void 0);
      yield* firstState(command, "Admitted");
      const admitted = yield* Frame.inspect;
      const again = yield* Frame.inspect;
      expect(admitted.commands.records).toEqual([
        expect.objectContaining({ lifecycle: { _tag: "Admitted", admitted: 1 } }),
      ]);
      expect(again.commands).toEqual(admitted.commands);
      yield* startedTurns(1);
      expect(yield* Ref.get(control.started)).toEqual([1]);

      yield* Deferred.succeed(held, void 0);
      yield* command.settled;
      expect((yield* Frame.inspect).commands).toEqual({ _tag: "Available", records: [] });
    }),
  );

  withApp("keeps each root's commands in that root", () =>
    Effect.gen(function* () {
      const held = yield* gate(1);
      const other = yield* Layer.build(Frame.layer({ name: "other" }));
      const otherRegistry = Context.get(other, Inspection.Registry);
      const otherFrame = Context.get(other, Frame.Service);

      const here = yield* ref(Counter, "one");
      const there = yield* ref(Counter, "two").pipe(
        Effect.provideService(Inspection.Registry, otherRegistry),
      );
      const first = yield* here.send(1);
      const second = yield* there.send(5);
      yield* firstState(first, "Admitted");
      yield* firstState(second, "Applied");

      const mine = yield* Frame.inspect;
      const theirs = yield* otherFrame.inspect;
      expect(mine.commands.records.map((record) => record.commandId)).toEqual([first.commandId]);
      expect(theirs.commands).toEqual({ _tag: "Available", records: [] });
      expect(mine.root.id).not.toBe(theirs.root.id);

      yield* Deferred.succeed(held, void 0);
      yield* first.settled;
    }),
  );
});
