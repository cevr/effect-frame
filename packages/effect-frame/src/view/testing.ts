import { flush } from "@solidjs/signals";
import { QueryState, Source } from "effect-frame/actor/client";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Match,
  Option,
  Scope,
  Schema,
  SubscriptionRef,
} from "effect";
import * as Frame from "../frame.js";
import type { Host, HostEvent, PropertyValue, StaticProps } from "./host.js";

const DEFAULT_TIMEOUT: Duration.Input = "5 seconds";
const DIAGNOSTIC_TIMEOUT: Duration.Duration = Duration.millis(100);
const RECENT_OPERATION_LIMIT = 8;
const ROOT_SUMMARY_LIMIT = 2048;

const InspectionUnavailableReason = Schema.Literals([
  "FrameServiceMissing",
  "CollectionTimedOut",
  "CollectionDefect",
]);

const InspectionUnavailable = Schema.TaggedStruct("Unavailable", {
  reason: InspectionUnavailableReason,
});

const InspectionAvailable = Schema.TaggedStruct("Available", {
  snapshot: Frame.Snapshot,
});

/** A sampled Frame snapshot or the bounded reason it was unavailable. */
export const ConditionInspection = Schema.Union([InspectionAvailable, InspectionUnavailable]);
export type ConditionInspection = Schema.Schema.Type<typeof ConditionInspection>;

/** The named condition was not observed before its bounded deadline. */
export class ConditionNotObserved extends Schema.TaggedError<ConditionNotObserved>()(
  "ConditionNotObserved",
  {
    label: Schema.String,
    timeoutMillis: Schema.Finite,
    rootId: Schema.String,
    setupFinished: Schema.Boolean,
    actionFinished: Schema.Boolean,
    revisionAtStart: Schema.Finite,
    revisionAtFailure: Schema.Finite,
    predicateResult: Schema.Boolean,
    predicateChecked: Schema.Boolean,
    recentHostOperations: Schema.Array(Schema.String),
    rootDisposed: Schema.Boolean,
    listenersAttached: Schema.Finite,
    listenersReleased: Schema.Finite,
    rootSummary: Schema.String,
    inspection: ConditionInspection,
  },
) {}

/** The harness closed while a condition was waiting. */
export class HarnessClosed extends Schema.TaggedError<HarnessClosed>()("HarnessClosed", {
  label: Schema.String,
  rootId: Schema.String,
  revision: Schema.Finite,
  rootDisposed: Schema.Boolean,
  listenersAttached: Schema.Finite,
  listenersReleased: Schema.Finite,
}) {}

export interface Condition<HostNode> {
  /** A short description included in timeout and close failures. */
  readonly label: string;
  /** A synchronous, read-only predicate over the actual mounted root. */
  readonly until: (root: HostNode) => boolean;
  /** A finite, positive deadline. Defaults to five seconds. */
  readonly timeout?: Duration.Input;
}

export interface ViewTestOptions<HostNode, A, E, R> {
  readonly host: Host<HostNode>;
  readonly root: HostNode;
  readonly setup: (host: Host<HostNode>, root: HostNode) => Effect.Effect<A, E, R>;
  /** An optional identity included in failure receipts. */
  readonly rootId?: string;
  /** An optional bounded summary for timeout receipts. */
  readonly summarizeRoot?: (root: HostNode) => string;
}

export interface ViewTest<HostNode, A> {
  readonly setup: A;
  readonly root: HostNode;
  readonly waitFor: (
    condition: Condition<HostNode>,
  ) => Effect.Effect<void, ConditionNotObserved | HarnessClosed>;
  readonly act: <B, E, R>(
    action: Effect.Effect<B, E, R>,
    condition: Condition<HostNode>,
  ) => Effect.Effect<B, E | ConditionNotObserved | HarnessClosed, Exclude<R, Scope.Scope>>;
  /** Closing is idempotent and releases setup resources and pending waits. */
  readonly close: Effect.Effect<void>;
}

interface Waiter {
  readonly afterRevision: number;
  readonly onClose: () => HarnessClosed;
  readonly resume: (effect: Effect.Effect<void, HarnessClosed>) => void;
  done: boolean;
}

interface CloseWaiter {
  readonly onClose: () => HarnessClosed;
  readonly resume: (effect: Effect.Effect<never, HarnessClosed>) => void;
  done: boolean;
}

interface HarnessState<HostNode> {
  readonly root: HostNode;
  readonly rootId: string;
  readonly summarizeRoot: Option.Option<(root: HostNode) => string>;
  readonly frame: Option.Option<Frame.FrameService>;
  /** The construction context supplies the application services to inspection only. */
  readonly applicationContext: Context.Context<never>;
  readonly liveClock: Clock.Clock;
  readonly collectionScopes: Set<Scope.Scope>;
  readonly waiters: Set<Waiter>;
  readonly closeWaiters: Set<CloseWaiter>;
  readonly recentHostOperations: Array<string>;
  revision: number;
  closed: boolean;
  disposalComplete: boolean;
  listenersAttached: number;
  listenersReleased: number;
}

const closeError = <HostNode>(state: HarnessState<HostNode>, label: string): HarnessClosed =>
  HarnessClosed.make({
    label,
    rootId: state.rootId,
    revision: state.revision,
    rootDisposed: state.disposalComplete,
    listenersAttached: state.listenersAttached,
    listenersReleased: state.listenersReleased,
  });

const finishWaiter = <HostNode>(
  state: HarnessState<HostNode>,
  waiter: Waiter,
  effect: Effect.Effect<void, HarnessClosed>,
): void => {
  if (waiter.done) {
    return;
  }
  waiter.done = true;
  state.waiters.delete(waiter);
  waiter.resume(effect);
};

const finishCloseWaiter = <HostNode>(
  state: HarnessState<HostNode>,
  waiter: CloseWaiter,
  effect: Effect.Effect<never, HarnessClosed>,
): void => {
  if (waiter.done) {
    return;
  }
  waiter.done = true;
  state.closeWaiters.delete(waiter);
  waiter.resume(effect);
};

const recordMutation = <HostNode>(state: HarnessState<HostNode>, operation: string): void => {
  state.revision += 1;
  state.recentHostOperations.push(operation);
  if (state.recentHostOperations.length > RECENT_OPERATION_LIMIT) {
    state.recentHostOperations.shift();
  }
  for (const waiter of Array.from(state.waiters)) {
    if (state.revision > waiter.afterRevision) {
      finishWaiter(state, waiter, Effect.void);
    }
  }
};

const observeHost = <HostNode>(
  host: Host<HostNode>,
  state: HarnessState<HostNode>,
): Host<HostNode> => {
  const write = <A>(operation: string, run: () => A): A => {
    const value = run();
    recordMutation(state, operation);
    return value;
  };

  return {
    createElement: (tag: string, staticProps: StaticProps) => host.createElement(tag, staticProps),
    createText: (text: string) => host.createText(text),
    createDetachedElement: host.createDetachedElement,
    createDetachedText: host.createDetachedText,
    setProperty: (node: HostNode, name: string, value: PropertyValue) =>
      write("setProperty", () => host.setProperty(node, name, value)),
    insert: (parent: HostNode, node: HostNode, anchor) =>
      write("insert", () => host.insert(parent, node, anchor)),
    remove: (parent: HostNode, node: HostNode) => write("remove", () => host.remove(parent, node)),
    setText: (node: HostNode, text: string) => write("setText", () => host.setText(node, text)),
    addEventListener: (node: HostNode, name: string, handler: (event: HostEvent) => void) => {
      const cleanup = host.addEventListener(node, name, handler);
      state.listenersAttached += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        state.listenersReleased += 1;
        cleanup();
      };
    },
    attach: (node: HostNode, run: (node: HostNode) => void) => host.attach(node, run),
  };
};

const awaitRevision = <HostNode>(
  state: HarnessState<HostNode>,
  afterRevision: number,
  label: string,
): Effect.Effect<void, HarnessClosed> =>
  Effect.callback<void, HarnessClosed>((resume) => {
    if (state.closed) {
      resume(Effect.fail(closeError(state, label)));
      return;
    }
    if (state.revision > afterRevision) {
      resume(Effect.void);
      return;
    }

    const waiter: Waiter = {
      afterRevision,
      onClose: () => closeError(state, label),
      resume,
      done: false,
    };
    state.waiters.add(waiter);

    // This second check is the handshake. It closes the gap between the
    // initial revision read and registration if a host write happened there.
    if (state.closed) {
      finishWaiter(state, waiter, Effect.fail(waiter.onClose()));
    } else if (state.revision > afterRevision) {
      finishWaiter(state, waiter, Effect.void);
    }

    return Effect.sync(() => {
      state.waiters.delete(waiter);
      waiter.done = true;
    });
  });

const awaitClose = <HostNode>(
  state: HarnessState<HostNode>,
  label: string,
): Effect.Effect<never, HarnessClosed> =>
  Effect.callback<never, HarnessClosed>((resume) => {
    if (state.closed) {
      resume(Effect.fail(closeError(state, label)));
      return;
    }
    const waiter: CloseWaiter = {
      onClose: () => closeError(state, label),
      resume,
      done: false,
    };
    state.closeWaiters.add(waiter);
    if (state.closed) {
      finishCloseWaiter(state, waiter, Effect.fail(waiter.onClose()));
    }
    return Effect.sync(() => {
      state.closeWaiters.delete(waiter);
      waiter.done = true;
    });
  });

const conditionObservation = <HostNode>(
  state: HarnessState<HostNode>,
  condition: Condition<HostNode>,
  onPredicate: (value: boolean) => void,
): Effect.Effect<{ readonly satisfied: boolean; readonly revision: number }, never> =>
  Effect.gen(function* () {
    // Leave a host callback's Solid flush stack before entering the next one.
    yield* Effect.yieldNow;
    return yield* Effect.sync(() => {
      flush();
      const satisfied = condition.until(state.root);
      onPredicate(satisfied);
      return { satisfied, revision: state.revision };
    });
  });

const waitForCondition = <HostNode>(
  state: HarnessState<HostNode>,
  condition: Condition<HostNode>,
  onPredicate: (value: boolean) => void,
): Effect.Effect<void, HarnessClosed> =>
  Effect.gen(function* () {
    while (true) {
      const observation = yield* conditionObservation(state, condition, onPredicate);
      if (observation.satisfied) {
        return;
      }
      yield* awaitRevision(state, observation.revision, condition.label);
    }
  });

const timeoutInput = <HostNode>(condition: Condition<HostNode>): Duration.Input =>
  Option.match(Option.fromNullishOr(condition.timeout), {
    onNone: () => DEFAULT_TIMEOUT,
    onSome: (input) => input,
  });

interface ConditionFailureData {
  readonly label: string;
  readonly timeoutMillis: number;
  readonly rootId: string;
  readonly setupFinished: boolean;
  readonly actionFinished: boolean;
  readonly revisionAtStart: number;
  readonly revisionAtFailure: number;
  readonly predicateResult: boolean;
  readonly predicateChecked: boolean;
  readonly recentHostOperations: ReadonlyArray<string>;
  readonly rootDisposed: boolean;
  readonly listenersAttached: number;
  readonly listenersReleased: number;
  readonly rootSummary: string;
}

const conditionFailureData = <HostNode>(
  state: HarnessState<HostNode>,
  condition: Condition<HostNode>,
  milliseconds: number,
  revisionAtStart: number,
  actionFinished: boolean,
  predicateResult: boolean,
  predicateChecked: boolean,
): ConditionFailureData => ({
  label: condition.label,
  timeoutMillis: milliseconds,
  rootId: state.rootId,
  setupFinished: true,
  actionFinished,
  revisionAtStart,
  revisionAtFailure: state.revision,
  predicateResult,
  predicateChecked,
  recentHostOperations: [...state.recentHostOperations],
  rootDisposed: state.disposalComplete,
  listenersAttached: state.listenersAttached,
  listenersReleased: state.listenersReleased,
  rootSummary: Option.match(state.summarizeRoot, {
    onNone: () => "",
    onSome: (summarize) => summarize(state.root).slice(0, ROOT_SUMMARY_LIMIT),
  }),
});

const unavailableInspection = (
  reason: Schema.Schema.Type<typeof InspectionUnavailableReason>,
): ConditionInspection => ({
  _tag: "Unavailable",
  reason,
});

const collectInspection = <HostNode>(
  state: HarnessState<HostNode>,
  ownerScope: Scope.Scope,
): Effect.Effect<ConditionInspection> =>
  Option.match(state.frame, {
    onNone: () => Effect.succeed(unavailableInspection("FrameServiceMissing")),
    onSome: (frame) => {
      if (state.closed) {
        return Effect.succeed(unavailableInspection("CollectionDefect"));
      }
      const collectionScope = Scope.forkUnsafe(ownerScope);
      state.collectionScopes.add(collectionScope);
      const diagnosticTimeout = Symbol("ViewTestDiagnosticTimeout");
      const collection = Effect.gen(function* () {
        const inspectionFiber = yield* Effect.forkIn(
          Effect.exit(Effect.provideContext(frame.inspect, state.applicationContext)),
          collectionScope,
        );
        const result = yield* Effect.ensuring(
          Effect.raceFirst(
            Fiber.join(inspectionFiber),
            state.liveClock.sleep(DIAGNOSTIC_TIMEOUT).pipe(Effect.as(diagnosticTimeout)),
          ),
          Fiber.interrupt(inspectionFiber),
        );
        if (result === diagnosticTimeout) {
          return unavailableInspection("CollectionTimedOut");
        }
        if (Exit.isSuccess(result)) {
          return { _tag: "Available", snapshot: result.value } satisfies ConditionInspection;
        }
        return unavailableInspection("CollectionDefect");
      });
      return Effect.ensuring(
        collection.pipe(
          Effect.catchCause(() => Effect.succeed(unavailableInspection("CollectionDefect"))),
        ),
        Scope.close(collectionScope, Exit.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.collectionScopes.delete(collectionScope);
            }),
          ),
        ),
      );
    },
  });

const runBounded = <HostNode, A, E, R>(
  state: HarnessState<HostNode>,
  ownerScope: Scope.Scope,
  condition: Condition<HostNode>,
  operation: (
    operationScope: Scope.Scope,
    setActionFinished: () => void,
    setPredicateResult: (value: boolean) => void,
  ) => Effect.Effect<A, E | HarnessClosed, Exclude<R, Scope.Scope>>,
): Effect.Effect<A, E | ConditionNotObserved | HarnessClosed, Exclude<R, Scope.Scope>> =>
  Effect.suspend(() => {
    const duration = Duration.fromInputUnsafe(timeoutInput(condition));
    if (!Duration.isFinite(duration) || !Duration.isPositive(duration)) {
      return Effect.die(
        new Error(`ViewTest condition timeout must be finite and positive: ${condition.label}`),
      );
    }
    // Do this check before forking. A closed owner scope interrupts a forked
    // child before its operation can report HarnessClosed to the caller.
    if (state.closed) {
      return Effect.fail(closeError(state, condition.label));
    }
    const operationScope = Scope.forkUnsafe(ownerScope);
    const milliseconds = Duration.toMillis(duration);
    const revisionAtStart = state.revision;
    let actionFinished = false;
    let predicateResult = false;
    let predicateChecked = false;
    const markActionFinished = (): void => {
      actionFinished = true;
    };
    const markPredicateResult = (value: boolean): void => {
      predicateResult = value;
      predicateChecked = true;
    };
    const work = Effect.gen(function* () {
      // The first check closes the ordinary after-close path. This check
      // covers a close that wins after the operation scope was allocated but
      // before its fiber starts. The awaitClose race remains the concurrent
      // close path once the operation is already running.
      if (state.closed) {
        return yield* closeError(state, condition.label);
      }
      const fiber = yield* Effect.forkIn(
        operation(operationScope, markActionFinished, markPredicateResult),
        operationScope,
      );
      return yield* Effect.ensuring(Fiber.join(fiber), Scope.close(operationScope, Exit.void));
    });
    const timeoutMarker = Symbol("ViewTestTimeout");
    const watchdog = state.liveClock.sleep(duration).pipe(Effect.as(timeoutMarker));
    return Effect.gen(function* () {
      const result = yield* Effect.exit(
        Effect.raceFirst(Effect.raceFirst(work, awaitClose(state, condition.label)), watchdog),
      );
      if (Exit.isFailure(result)) {
        return yield* Effect.failCause(result.cause);
      }
      if (result.value !== timeoutMarker) {
        return result.value;
      }

      // Commit the timeout receipt before awaiting any asynchronous
      // diagnostics. A later host write cannot turn this result into success.
      const failure = conditionFailureData(
        state,
        condition,
        milliseconds,
        revisionAtStart,
        actionFinished,
        predicateResult,
        predicateChecked,
      );
      const inspection = yield* collectInspection(state, ownerScope);
      return yield* ConditionNotObserved.make({ ...failure, inspection });
    });
  });

/**
 * Build a scoped harness around the production Host and mount function.
 *
 * The harness observes actual host writes. It waits for a named synchronous
 * root condition after setup or an action. It does not infer application idle
 * state, drain every Effect fiber, or advance the application's Clock.
 */
export const make = Effect.fn("ViewTest.make")(function* <HostNode, A, E, R>(
  options: ViewTestOptions<HostNode, A, E, R>,
) {
  const parentScope = yield* Effect.scope;
  const harnessScope = Scope.forkUnsafe(parentScope);
  const frame = yield* Effect.serviceOption(Frame.Service);
  const applicationContext = Context.omit(Scope.Scope)(yield* Effect.context<R>());
  const state: HarnessState<HostNode> = {
    root: options.root,
    rootId: Option.match(Option.fromNullishOr(options.rootId), {
      onNone: () => "",
      onSome: (rootId) => rootId,
    }),
    summarizeRoot: Option.fromNullishOr(options.summarizeRoot),
    frame,
    applicationContext,
    // The test application's Clock can be TestClock. Keep the watchdog on
    // Effect's live default without replacing the clock used by the app.
    liveClock: Context.get(Context.empty(), Clock.Clock),
    collectionScopes: new Set(),
    waiters: new Set(),
    closeWaiters: new Set(),
    recentHostOperations: [],
    revision: 0,
    closed: false,
    disposalComplete: false,
    listenersAttached: 0,
    listenersReleased: 0,
  };
  const observedHost = observeHost(options.host, state);

  const closeState = (): void => {
    if (state.closed) {
      return;
    }
    state.closed = true;
    for (const waiter of Array.from(state.waiters)) {
      finishWaiter(state, waiter, Effect.fail(waiter.onClose()));
    }
    for (const waiter of Array.from(state.closeWaiters)) {
      finishCloseWaiter(state, waiter, Effect.fail(waiter.onClose()));
    }
  };
  const closeStateEffect = Effect.sync(closeState);
  const closeCollectionScopes = Effect.suspend(() =>
    Effect.forEach([...state.collectionScopes], (scope) => Scope.close(scope, Exit.void), {
      discard: true,
    }),
  );
  yield* Scope.addFinalizer(
    harnessScope,
    Effect.sync(() => {
      state.disposalComplete = true;
    }),
  );
  yield* Scope.addFinalizer(parentScope, closeStateEffect);

  const setup = yield* options.setup(observedHost, options.root).pipe(
    Effect.provideService(Scope.Scope, harnessScope),
    Effect.onExit((exit) => {
      if (Exit.isFailure(exit)) {
        return closeStateEffect.pipe(Effect.andThen(Scope.close(harnessScope, exit)));
      }
      return Effect.void;
    }),
  );

  const waitFor = (
    condition: Condition<HostNode>,
  ): Effect.Effect<void, ConditionNotObserved | HarnessClosed> =>
    runBounded(state, harnessScope, condition, (_operationScope, _markActionFinished, mark) =>
      Effect.gen(function* () {
        if (state.closed) {
          return yield* closeError(state, condition.label);
        }
        yield* waitForCondition(state, condition, mark);
        return;
      }).pipe(Effect.asVoid),
    );

  const act = <B, EA, RA>(
    action: Effect.Effect<B, EA, RA>,
    condition: Condition<HostNode>,
  ): Effect.Effect<B, EA | ConditionNotObserved | HarnessClosed, Exclude<RA, Scope.Scope>> =>
    runBounded(state, harnessScope, condition, (operationScope, markActionFinished, mark) =>
      Effect.gen(function* () {
        if (state.closed) {
          return yield* closeError(state, condition.label);
        }
        // Establish the first observation before the action begins. The
        // post-action check remains authoritative for the returned result.
        yield* conditionObservation(state, condition, mark);
        const result = yield* action.pipe(Effect.provideService(Scope.Scope, operationScope));
        markActionFinished();
        yield* waitForCondition(state, condition, mark);
        return result;
      }),
    );

  const close = closeStateEffect.pipe(
    Effect.andThen(closeCollectionScopes),
    Effect.andThen(Scope.close(harnessScope, Exit.void)),
  );

  return { setup, root: options.root, waitFor, act, close } satisfies ViewTest<HostNode, A>;
});

/**
 * A query source a test drives by hand: a `Source<QueryState<…>>` whose
 * transitions the test controls, which is the whole surface `View.ready`
 * and the readiness boundaries consume.
 */
export interface FakeQuery<Value, Error> {
  readonly source: Source<QueryState<Value, Error>>;
  /** Deliver a first value, or replace one. */
  readonly resolve: (value: Value) => Effect.Effect<void>;
  /** Hold the current value and mark it stale, as a refetch does. */
  readonly refetch: Effect.Effect<void>;
  readonly reject: (error: Error) => Effect.Effect<void>;
}

/**
 * Make a `FakeQuery` that starts at `initial`.
 *
 * ```ts
 * const query = yield* ViewTest.fakeQuery(QueryState.Loading<string, never>());
 * yield* query.resolve("Alpha");
 * ```
 */
export const fakeQuery: <Value, Error>(
  initial: QueryState<Value, Error>,
) => Effect.Effect<FakeQuery<Value, Error>> = Effect.fn("ViewTest.fakeQuery")(function* <
  Value,
  Error,
>(initial: QueryState<Value, Error>) {
  const ref = yield* SubscriptionRef.make(initial);
  return {
    source: Source.fromSubscriptionRef(ref),
    resolve: (value: Value) =>
      SubscriptionRef.set(ref, QueryState.Ready<Value, Error>(value, false)),
    refetch: SubscriptionRef.update(ref, (state) =>
      Match.value(state).pipe(
        Match.withReturnType<QueryState<Value, Error>>(),
        Match.tagsExhaustive({
          Loading: (current) => current,
          Ready: (current) => QueryState.Ready<Value, Error>(current.value, true),
          Failed: () => QueryState.Loading<Value, Error>(),
        }),
      ),
    ),
    reject: (error: Error) => SubscriptionRef.set(ref, QueryState.Failed<Value, Error>(error)),
  } satisfies FakeQuery<Value, Error>;
});
