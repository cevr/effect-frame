import {
  ActorHost,
  Behavior,
  MailboxStore,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import {
  ActorTransport,
  Form,
  Generated,
  Unreachable,
  contract,
  ref,
  spawn,
} from "effect-frame/actor/client";
import type { CommandId, TransportService } from "effect-frame/actor/client";
import { Html, View } from "effect-frame/view";
import { Effect, Layer, Match, Option, Ref, Schema } from "effect";

/**
 * One contract and one page for the plain-form proofs (#21, #32). `AddTask`
 * derives its id from the command id; `Tag` draws a fresh one beside it;
 * `done` is a checkbox, so its absence is `false`.
 */

export const AddTask = Schema.TaggedStruct("AddTask", {
  id: Generated.fromCommandId(Schema.String),
  title: Schema.String.check(Schema.isMaxLength(12)),
  done: Form.Checkbox,
  note: Schema.optionalKey(Schema.String),
});

export const Tag = Schema.TaggedStruct("Tag", {
  id: Generated.freshId(Schema.String, 8),
  label: Schema.String,
});

export const TasksMessage = Schema.Union([AddTask, Tag]);
export type TasksMessage = Schema.Schema.Type<typeof TasksMessage>;

const Task = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean });

export const TasksSnapshot = Schema.Struct({
  tasks: Schema.Array(Task),
  tags: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export type TasksSnapshot = Schema.Schema.Type<typeof TasksSnapshot>;

export const Tasks = contract("Tasks", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ tenant: Schema.String, board: Schema.String }),
  snapshot: TasksSnapshot,
  message: TasksMessage,
});

export const board = { tenant: "acme", board: "main" };

const reduce = (state: TasksSnapshot, message: TasksMessage): TasksSnapshot =>
  Match.type<TasksMessage>().pipe(
    Match.tagsExhaustive({
      AddTask: (add) => ({
        ...state,
        tasks: [...state.tasks, { id: add.id, title: add.title, done: add.done }],
      }),
      Tag: (tag) => ({ ...state, tags: [...state.tags, { id: tag.id, label: tag.label }] }),
    }),
  )(message);

export const TasksLive = implementTransparent(
  Tasks,
  Behavior.reducer<TasksSnapshot, TasksMessage>({ initial: { tasks: [], tags: [] }, reduce }),
);

/** What reached the transport: every send, in order, and a lost-reply switch. */
export interface Wire {
  readonly sends: Ref.Ref<
    ReadonlyArray<{ readonly commandId: CommandId; readonly payload: string }>
  >;
  /** When set, the next send applies and then its reply is lost. */
  readonly loseNextReply: Ref.Ref<boolean>;
}

export const makeWire = Effect.gen(function* () {
  const wire: Wire = {
    sends: yield* Ref.make<
      ReadonlyArray<{ readonly commandId: CommandId; readonly payload: string }>
    >([]),
    loseNextReply: yield* Ref.make(false),
  };
  return wire;
});

/** The one policy table: `Tasks` declares `public`, and it allows everything. */
export const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

/** The real in-process host, recording each send and able to lose one reply. */
export const recordedTransport = (wire: Wire) =>
  Layer.effect(
    ActorTransport,
    Effect.gen(function* () {
      const real = yield* ActorHost.make({
        implementations: [TasksLive],
        store: () => MailboxStore.layerMemory,
      });
      const transport: TransportService = {
        ...real,
        send: (address, commandId, payload, active) =>
          Effect.gen(function* () {
            yield* Ref.update(wire.sends, (seen) => [...seen, { commandId, payload }]);
            const receipt = yield* real.send(address, commandId, payload, active);
            const lose = yield* Ref.getAndSet(wire.loseNextReply, false);
            if (lose) {
              return yield* Unreachable.make({ reason: "reply lost" });
            }
            return receipt;
          }),
      };
      return transport;
    }),
  ).pipe(
    Layer.provide(policies),
    // Every name `Tasks` declares is in the table above; a miss is a bug in this file.
    Layer.orDie,
  );

export interface NoProps {
  readonly _tag: "NoProps";
}

export const noProps: NoProps = { _tag: "NoProps" };

/**
 * One page, every host: an `AddTask` form, a `Tag` form, and the count.
 * The title input is bound to a local draft, as the notes compose input is.
 */
export const TasksPage = (_props: NoProps) =>
  Effect.gen(function* () {
    const tasks = yield* ref(Tasks, board);
    const draft = yield* spawn(Behavior.value(""));
    const add = yield* View.form({
      ref: tasks,
      contract: Tasks,
      key: board,
      message: AddTask,
      typed: ["title", "done", "note"],
      endpoint: "/actors",
      returnTo: "/",
    });
    const tag = yield* View.form({
      ref: tasks,
      contract: Tasks,
      key: board,
      message: Tag,
      typed: ["label"],
      endpoint: "/actors",
      returnTo: "/",
    });
    return (
      <main>
        <form id="add" onSubmit={add.submit}>
          <input id="title" name="title" value={View.bind(draft.state)} />
          <input id="done" type="checkbox" name="done" />
          <textarea id="note" name="note"></textarea>
          <input id="pin" name="_pin" />
          <button type="submit">add</button>
        </form>
        <ul id="issues">
          {add.issues.map((issue) => (
            <li data-field={issue.field}>{issue.message}</li>
          ))}
        </ul>
        <form id="tag" onSubmit={tag.submit}>
          <input id="label" name="label" />
        </form>
        <p id="count">{View.bind(tasks.state, (state) => state.tasks.length)}</p>
      </main>
    );
  });

/**
 * The document: the page, and the refused post's issues when this render
 * redraws one, so the hydrating client draws the same form.
 */
export const TasksDocument = Effect.scoped(
  Effect.gen(function* () {
    const body = yield* Html.renderToString(TasksPage, noProps);
    const issues = yield* Effect.serviceOption(Form.FormContext);
    const script = yield* Option.match(issues, {
      onNone: () => Effect.succeed(""),
      onSome: (found) =>
        Effect.map(Form.encodeIssues(found), (json) => Html.jsonScript(Form.issuesScriptId, json)),
    });
    return `<main id="app">${body}</main>${script}`;
  }),
);

/** The hidden inputs a rendered form carries, in document order. */
export const hiddenOf = (html: string, formId: string): ReadonlyArray<[string, string]> => {
  const start = html.indexOf(`<form id="${formId}"`);
  const end = html.indexOf("</form>", start);
  const form = html.slice(start, end);
  return Array.from(
    form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g),
    (match): [string, string] => [unescape(String(match[1])), unescape(String(match[2]))],
  );
};

const unescape = (text: string): string =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The value a hidden field carries in a rendered form. */
export const hiddenValue = (html: string, formId: string, name: string): string =>
  Option.getOrElse(
    Option.map(
      Option.fromNullishOr(hiddenOf(html, formId).find(([field]) => field === name)),
      ([, value]) => value,
    ),
    () => "",
  );
