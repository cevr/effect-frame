# Effect Frame: full-stack interface sketches

Date: 2026-09-18. Reconciled from the Codex design session (05:20–06:57 UTC) and the command contract in [Define one command contract across local and durable actors](https://github.com/cevr/effect-frame/issues/5).

These are interface sketches, not an implementation. `effect-frame/*` is a placeholder module path. `View`, `Actor`, `Behavior`, `Route`, and `MailboxStore` are proposed interfaces. Their code has not passed a type check. Domain schemas and small selectors are omitted where they do not affect the interface.

## As built

Updated 2026-09-18 after tickets #6 to #10 closed. The sketches below stay as the design record. This table says what the code does where it differs. Commits are on local `main`; nothing is pushed.

| Sketch                                                                                    | Built                                                                                                                                                                       | Where                                                                            |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Actor.contract(name, { key, snapshot, messages: { Add: {...} } })`                       | `contract(name, { version, key, snapshot, message })` where `message` is a `Schema.Union` of `Schema.TaggedStruct` members; no generated constructors, no per-message error | `packages/effect-frame/src/actor/contract.ts`                                    |
| `Actor.implement(Counter, { behavior, snapshot })`                                        | `implement(contract, { behavior, state, snapshot })` and `implementTransparent(contract, behavior)`; `state` is the persisted codec, `snapshot` the public projection       | `packages/effect-frame/src/actor/implement.ts`                                   |
| `Actor.durable(CounterLive)` at the call site                                             | `ActorHost.layer({ implementations, store })`: the host decides placement, the implementation stays a value                                                                 | `packages/effect-frame/src/actor/host.ts`                                        |
| `Actor.ref(Counter, id)` on the client                                                    | `ref(contract, key, { resume })` returns `ActorRef<Snapshot, Message, "remote">`; a third kind that adds `RemoteFailure` to the error set                                   | `packages/effect-frame/src/actor/ref.ts`, `vocabulary.ts`                        |
| `ActorRef.state: Source<State>`                                                           | plus `applied: Source<Applied<State>>` carrying the revision on every kind                                                                                                  | `packages/effect-frame/src/actor/vocabulary.ts`                                  |
| `counter.call(Counter.Add({ amount: 1 }), { timeout })`                                   | `call(message, { commandId, timeout })`; the client generates the command id; local refs take no options                                                                    | `packages/effect-frame/tests/actor/types.test.ts`                                |
| one wire, unspecified                                                                     | JSON verbs `send`, `call`, `snapshot` and a `text/event-stream` of revisions; typed failures as tagged JSON with a status; reconnect from the last revision                 | `packages/effect-frame/src/actor/http/*`                                         |
| `Route.page({ server: { load, render }, client: { hydrate } })`                           | not a primitive yet; composed from `Html.renderToString`, `Html.jsonScript`, `Dom.readJsonScript`, `Dom.hydrate`, `resumeCodec`                                             | `packages/effect-frame/src/view/hosts/html.ts`, `dom.ts`; `apps/notes`           |
| a view is `(props) => Effect<Node, E, R>` with module `bind`, `select`, `event`, `submit` | as sketched; `Host` is seven operations; `HostEvent { value, preventDefault }` is normalized by the host                                                                    | `packages/effect-frame/src/view/view.ts`, `host.ts`                              |
| Solid 2 OpenTUI port                                                                      | not needed: the runtime owns its host interface and uses `@solidjs/signals` as a private scheduler                                                                          | `packages/effect-frame/src/view/runtime.ts`, `hosts/opentui.ts`                  |
| `MailboxStore` with `claimNext`                                                           | `next` (no claim token), `commit`, `advance` for autonomous transitions, `receipt`, `pending`, `latest`; eight-case conformance suite                                       | `packages/effect-frame/src/actor/mailbox-store.ts`, `src/testing/conformance.ts` |
| celld as the proof host                                                                   | `StorageStore` over Durable Object SQL; SIGKILL and restart harness; generic Durable Object host over the same wire                                                         | `packages/host-durable-object`                                                   |

## Superseded forms

The original sketch document used forms that later turns rejected. Do not build these:

| Rejected                                      | Replaced by                                         | Reason                                                          |
| --------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `((props, ui) => ...)`                        | `View.bind` / `View.event` module functions         | A binding is data; the runtime owns the scope it forks into     |
| `LocalActor.spawn`, `RemoteActor.connect`     | `Actor.spawn`, `Actor.ref`                          | Location is a declaration, not a second interface               |
| `Actor.remote(Counter, { runtime: "celld" })` | `Actor.durable(Counter)`                            | Application code does not name the host; the Alchemy Layer does |
| `createSignal`, `createMemo` as primitives    | `Behavior.value`, `select`                          | One actor interface for simple state and machines               |
| `State.make`, `Query.make`, `Action.make`     | actors and views                                    | Superseded when actors arrived                                  |
| `actor.setState(...)`                         | declared messages                                   | A universal setter bypasses the machine                         |
| Encore `Actor.fromEntity`, Encore workflows   | `Actor.contract`, Effect `WorkflowEngine` interface | Effect Frame does not depend on Effect Encore                   |
| `CellActor.make`                              | durable actor over `MailboxStore`                   | Effect Frame supplies the mailbox on every host                 |

## Recommendation

Keep Solid's fine-grained view model, JSX, keyed control flow, and host renderer interface. Add explicit source bindings and Effect-owned setup. Use one reactive graph for presentation. Start with Solid 2 as that graph; do not maintain a second writable Atom graph in parallel. Solid is an implementation detail behind `bind`; it is not the public API.

Use one actor interface on the client and the server. A behavior defines what messages mean. An actor owns identity, a mailbox, and a lifetime. Effect Machine supplies one kind of behavior. Plain values and reducers supply the others. Actors and machines have separate use cases and compose.

Alchemy supplies the hosts. Effect Frame supplies the mailbox. The user writes the stack and selects Cloudflare, celld, or Rivet.

Local UI state remains local. Shared domain state remains on the server. A remote projection is a read-only view of committed server state. It is not a second authority.

## 1. The actor interface

```ts
import { Actor, Behavior } from "effect-frame";

const program = Effect.gen(function* () {
  const count = yield* Actor.spawn(Behavior.value(0));
  const editor = yield* Actor.spawn(Behavior.machine(EditorMachine));

  count.state; // Source<number>
  editor.state; // Source<EditorState>

  yield* count.send(Value.Set(10));
  yield* editor.send(EditorEvent.Save);
});
```

The shared reference type:

```ts
interface ActorRef<State, Message, Kind extends ActorKind = "local"> {
  readonly state: Source<State>;

  readonly send: (message: Message) => Effect.Effect<Receipt<Kind>, SendError<Kind>>;

  readonly call: <M extends Message>(
    message: M,
    options: CallOptions<Kind>,
  ) => Effect.Effect<CallResult<M>, CallError<M, Kind>>;
}
```

`Kind` selects the receipt and error types. A local ref has no command ID and no uncertain error. A durable ref requires a command ID on the receipt and a timeout on `call`, and adds a typed `Uncertain` error. Placement is visible in the type. There is no second interface for durable refs.

Behaviors:

| Behavior                                  | Defines                                     |
| ----------------------------------------- | ------------------------------------------- |
| `Behavior.value(initial)`                 | Replacement by a serializable `Set` message |
| `Behavior.reducer({ initial, handlers })` | Event-to-state transitions                  |
| `Behavior.machine(Machine)`               | States, valid events, guards, tasks         |

Rules:

- The actor owns execution and lifetime. The behavior defines what messages mean.
- Selectors do not become new actors. `select(count.state, n => n * 2)` is a read-only projection with no mailbox.
- Machines do not expose unrestricted setters.
- `Behavior.value` accepts a `Set` message only. A `modify(fn)` helper exists on a local ref. It is absent from a durable ref type because an updater function cannot cross the durable boundary.
- `send` returns a receipt. It means accepted for processing.
- `call` waits for processing. It returns the result and the applied revision.
- `state` is the latest observed snapshot. It is not a synchronous read of remote memory.
- Messages execute in ordered turns per reference. The mailbox preserves admission order.
- Timeout means an unknown outcome. Retries reuse the command ID. Stopping the local wait does not undo an accepted command.
- Effect Machine's `ActorRef` and `ActorSystem` are hidden behind `Behavior.machine`. They are not the public type.

## 2. The small UI shape

```tsx
export const Counter = ((props) =>
  Effect.gen(function* () {
    const counter = yield* Actor.spawn(Behavior.machine(CounterMachine));

    const count = View.select(counter.state, (state) => state.count);

    return (
      <button onClick={View.event(() => counter.send(CounterEvent.Increment))}>
        Count: {View.bind(count)}
      </button>
    );
  }),
);
```

Rules:

- A view is a function from props to one setup Effect per mounted identity. State updates do not run setup again.
- Setup can fail or require services. Its `E` and `R` types remain visible to the mounting application.
- `props` supplies component inputs. `View.bind` and `View.event` are module functions. `Scope` owns resource lifetimes.
- The view owns a Scope. `Actor.spawn` binds actor shutdown to that Scope.
- `select` takes an explicit source. It does not find dependencies through ambient reads.
- `bind` marks a dynamic JSX value. Ordinary JSX values remain static.
- `event` calls the event mapper synchronously, then runs its returned Effect in the view Scope. Expected failures must have a handler. Defects reach the error boundary.
- Plain presentation components need no Effect setup and no actor.

The closer-to-Solid alternative is `count()` inside JSX and `createMemo(() => count() * 2)`. That retains implicit dependency discovery and is rejected. Dependency propagation, cleanup, and batching happen automatically after the program declares their rules.

## 3. Contract, implementation, reference

The actor implementation stays on the server. The client imports its public contract. The public snapshot does not have to equal the internal state.

```ts
// contracts/counter.ts — browser-safe
import { Actor } from "effect-frame/contract";

const CounterSnapshot = Schema.Struct({ count: Schema.Number });

export const Counter = Actor.contract("Counter", {
  key: CounterId,
  snapshot: CounterSnapshot,

  messages: {
    Add: {
      payload: { amount: Schema.Number },
      success: CounterSnapshot,
      error: CounterError,
    },
  },
});
```

```ts
// server/counter.server.ts
import { Actor, Behavior } from "effect-frame";
import { Counter } from "../contracts/counter";

const counterBehavior = Behavior.reducer({
  initial: { count: 0 },
  handlers: {
    Add: (state, { amount }) => ({ count: state.count + amount }),
  },
});

export const CounterLive = Actor.implement(Counter, {
  behavior: counterBehavior,
  snapshot: (state) => ({ count: state.count }),
});

export const CounterDurable = Actor.durable(CounterLive);
```

```tsx
// web/counter.tsx
import { Counter } from "../contracts/counter";

export const CounterView = ((props: { counterId: CounterId }) =>
  Effect.gen(function* () {
    const counter = yield* Actor.ref(Counter, props.counterId);

    yield* counter.call(Counter.Add({ amount: 1 }), { timeout: "5 seconds" });

    return <span>{View.bind(counter.state, (state) => state.count)}</span>;
  }),
);
```

Placement is a one-line declaration change in server code. Consumers do not change. The build rejects a server module reachable from a browser entry. Tree-shaking is not a secret-removal mechanism. Code generation of the contract is deferred; the explicit split keeps imports and ownership visible.

## 4. The durable actor and the mailbox

One actor is one Durable Object. The platform places it. No host provides a per-actor mailbox, so Effect Frame supplies one over a storage adapter.

```ts
interface MailboxStore {
  readonly append: (command: EncodedCommand) => Effect.Effect<Appended, CommandConflict>;
  readonly claimNext: Effect.Effect<Option.Option<Claimed>>;
  readonly commit: (claim: Claimed, outcome: Outcome) => Effect.Effect<Receipt>;
  readonly receipt: (commandId: CommandId) => Effect.Effect<Option.Option<Receipt>>;
  readonly pending: Effect.Effect<ReadonlyArray<CommandId>>;
}
```

The store uses only the portable host operations: `get`, `put`, `delete`, `deleteAll`, `list`, `sql.exec`, `setAlarm`, `getAlarm`, `deleteAlarm`. It is designed to the capability intersection of the three hosts, which Rivet defines. An in-memory store and a Durable Object store both pass one conformance suite. celld is the proof host.

A committed command performs these steps:

1. Decode the request and verify its principal.
2. Append to the mailbox. Same ID with a different payload fails with `CommandConflict`, even when the two payload hashes are equal: the hash is only a fast refusal, and the store compares the payload text. Same ID with the same payload returns the stored receipt.
3. Claim the next command in admission order.
4. Check the behavior transition.
5. Commit the next state, the command result, and the revision in one local transaction.
6. Publish the committed revision.
7. Return the receipt through the host boundary.

The alarm is re-derived from the pending table on wake. A missed alarm does not lose work. An external service call must not remain inside the state transaction. Durable background work uses an outbox committed with state. Its completion returns as another command.

Effect Machine publishes state before its save hook runs. The durable actor does not use that hook. It drives the machine transition inside step 4 and owns the commit in step 5.

## 5. Client behavior

The client form has its own machine. It owns draft input and submission state. The server actor owns saved tasks.

```text
Editing -- Submit --> Submitting -- Saved --> Editing
                           |
                           +-- definite rejection --> Rejected
                           |
                           +-- Uncertain error -----> Uncertain

Uncertain -- Retry same command ID --> Submitting
Rejected  -- Edit -----------------> Editing
```

Reconciled with the command contract:

- The client generates the command ID at `Submit`, not during rendering. It stores the ID in the submission state and reuses it on `Retry`.
- The task calls `board.call(Board.AddTask(...), { timeout })`. Success produces `Saved` with the applied revision. A typed domain error produces `Rejected`. The typed `Uncertain` error produces `Uncertain`. The client never maps a transport failure to `Rejected` without proof.
- Exiting `Submitting` stops the local wait. It cannot undo a command the server has committed.

```ts
composerMachine.task(
  ComposerState.Submitting,
  ({ state }) =>
    Effect.flatMap(BoardRef, (board) =>
      board.call(Board.AddTask(state.command), { timeout: "10 seconds" }),
    ),
  {
    onSuccess: (result) => ComposerEvent.Saved({ revision: result.revision }),
    onFailure: (failure) => ComposerEvent.SubmissionFailed({ failure }),
  },
);
```

The reusable screen setup is Effect code. Its refs live in the caller's Scope.

```ts
export const BoardScreen = {
  make: Effect.fn("BoardScreen.make")(function* (input: BoardInput) {
    const board = yield* Actor.ref(Board, input.boardId, {
      initial: input.snapshot,
      resumeFrom: input.snapshot.revision,
    });

    const composer = yield* Actor.spawn(
      Behavior.machine(ComposerMachine, { input: { boardId: input.boardId } }),
    ).pipe(Effect.provideService(BoardRef, board));

    return { board, composer };
  }),
};
```

A durable ref's `state` is fed by the snapshot subscription. The connection has a tagged status such as `Connecting`, `Live`, `Reconnecting`, or `Unavailable`. A stale snapshot is separate from that status. Reconnect requests updates after the last committed revision. The server replays from a retained cursor or supplies a fresh snapshot. It must not lose events between snapshot load and subscription. Buffers are bounded; a slow client is told to resynchronize.

## 6. Browser JSX

```tsx
export const BoardPage = ((props: BoardInput) =>
  Effect.gen(function* () {
    const { board, composer } = yield* BoardScreen.make(props);

    const tasks = View.select(board.state, (snapshot) => snapshot.tasks);
    const draft = View.select(composer.state, ComposerSelectors.draft);
    const submitting = View.select(composer.state, ComposerSelectors.submitting);
    const message = View.select(composer.state, ComposerSelectors.message);
    const canRetry = View.select(composer.state, ComposerSelectors.canRetry);

    return (
      <main>
        <h1>Tasks</h1>
        <ConnectionStatus state={board.connection} />

        <ul>
          <For each={tasks} keyBy={(task) => task.id}>
            {(task) => <li>{View.bind(task, (value) => value.title)}</li>}
          </For>
        </ul>

        <form onSubmit={View.submit(() => composer.send(ComposerEvent.Submit))}>
          <input
            aria-label="New task"
            value={View.bind(draft)}
            disabled={View.bind(submitting)}
            onInput={View.event((event) =>
              composer.send(ComposerEvent.DraftChanged({ value: event.currentTarget.value })),
            )}
          />
          <button disabled={View.bind(submitting)}>Add task</button>
        </form>

        <p role="status">{View.bind(message)}</p>
        <Show when={canRetry}>
          <button onClick={View.event(() => composer.send(ComposerEvent.Retry))}>
            Retry this request
          </button>
        </Show>
      </main>
    );
  }),
);
```

`For`, `Show`, `Match`, and `Portal` accept explicit reactive sources. An element reaches its host node only through `attach={Dom.attach((el) => Effect)}`: a behaviour run once the node is in the document, in the scope that owns the element, composed in order when several are given. `Match` is exhaustive over a tagged union and takes the case table of Effect's `Match.tagsExhaustive`; `Query` is a `Match` over `QueryState`. Each `For` child receives a read-only source for its keyed item. Replacing an item under the same key updates that source. `bind(source, select)` is shorthand for a selected binding. `submit` prevents native form navigation and then runs the returned Effect.

## 7. Terminal JSX

The terminal uses the same screen setup, contract, and composer machine. It uses OpenTUI nodes.

```tsx
export const BoardTerminal = ((props: BoardInput) =>
  Effect.gen(function* () {
    const { board, composer } = yield* BoardScreen.make(props);
    const tasks = View.select(board.state, (snapshot) => snapshot.tasks);
    const draft = View.select(composer.state, ComposerSelectors.draft);

    return (
      <box flexDirection="column">
        <text>Tasks</text>
        <For each={tasks} keyBy={(task) => task.id}>
          {(task) => <text>{View.bind(task, (value) => value.title)}</text>}
        </For>
        <input
          value={View.bind(draft)}
          onInput={View.event((value) => composer.send(ComposerEvent.DraftChanged({ value })))}
          onSubmit={View.event(() => composer.send(ComposerEvent.Submit))}
        />
        <ComposerStatus actor={composer} />
      </box>
    );
  }),
);
```

Web and TUI share behavior, not layout components. The inspected OpenTUI Solid package pins Solid 1.9.12. A Solid 2 port of its reconciler is required work with no ticket yet.

## 8. Server rendering and hydration

```tsx
export const boardRoute = Route.page({
  path: "/boards/:boardId",
  params: Schema.Struct({ boardId: BoardId }),
  key: ({ params }) => params.boardId,

  server: {
    load: ({ params }) => BoardQueries.authorizedSnapshot(params.boardId),
    render: (snapshot) => <BoardStatic snapshot={snapshot} draft="" />,
  },

  client: {
    input: ({ params, data }) => ({ boardId: params.boardId, snapshot: data }),
    hydrate: BoardPage,
  },
});
```

The server request Scope owns loading and rendering. Schema encodes the public snapshot. The HTML writer escapes the payload. The browser restores the snapshot and attaches bindings before it applies newer revisions. Client actor activation and subscription happen at the client phase, not during server rendering.

Changing the route key closes the previous screen Scope before it activates the replacement. Closing a durable observation does not stop the server actor. Closing a local actor stops its tasks. Host shutdown must await Effect finalizers; a synchronous view disposer is not proof of completed cleanup.

## 9. Alchemy

The user writes the stack. Alchemy provisions the host. Effect Frame ships no provisioning and does not name a host in application code.

```ts
// stack.ts — user-owned
export const stack = Effect.gen(function* () {
  const fleet = yield* Celld.Fleet("actors", { instances: 3 });

  const server = yield* Celld.Worker(
    "board-app",
    { fleet, main: serverEntry },
    App.toWorker({ routes: [boardRoute], actors: [CounterDurable] }),
  );

  return server;
}).pipe(Effect.provide(Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.Ecs())));
```

Swapping `Celld` for `Cloudflare` or `Rivet` changes the stack, not the application. Alchemy's celld and Rivet support is open PR 1127. The PR pins celld 0.1.0; current celld is 0.5.0.

## 10. Durable work

Resumable work uses the Effect `WorkflowEngine.Encoded` interface with a store implemented over the same portable host operations. A behavior transition commits an outbox entry with state. A dispatcher starts the workflow with a stable ID. Completion returns as a typed command. Do not launch a job from rendering or from a volatile post-commit callback and call it durable.

## 11. Three reconciliation loops

| Loop              | Desired state                              | Managed state             |
| ----------------- | ------------------------------------------ | ------------------------- |
| View              | JSX nodes and bound values                 | DOM or OpenTUI nodes      |
| Actor supervision | Required live local tasks and child actors | Effect scopes and fibers  |
| Deployment        | Declared infrastructure resources          | Alchemy-managed resources |

They share stable identity and owned cleanup. They have different failure and durability rules. Behaviors still define legal transitions. A reconciler does not replace them.

## 12. Initial proof

1. One actor interface with a local value, a local machine, and a durable ref over the in-memory store. Ticket: [Test one actor interface for simple state and machines](https://github.com/cevr/effect-frame/issues/7).
2. One committed command with retry identity and `CommandConflict`.
3. One versioned snapshot subscription.
4. Browser SSR plus hydration.
5. One OpenTUI view of the same actor.
6. Restart on celld after commit but before reply, then retry the same command.

## Sources

- Codex session `~/.codex/sessions/2026/09/18/rollout-2026-09-18T01-18-56-01a0b2f4-1769-70d2-8e4b-f0f3457285ad.jsonl`, lines 283–755.
- [Define one command contract across local and durable actors](https://github.com/cevr/effect-frame/issues/5), comments 5732848682, 5733159130, 5733419331.
- `docs/research/celld-recovery.md`, `docs/research/owned-runtimes.md`, `docs/research/solid-renderers.md`.
- `CONTEXT.md` for the vocabulary: actor contract, actor behavior, actor reference, public snapshot, durable work record.
