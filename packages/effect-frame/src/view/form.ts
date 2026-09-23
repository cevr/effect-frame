import type {
  AnyContract,
  CommandId,
  IdentifiedCommandHandle,
  KeyOf,
  MessageOf,
  RemoteActorRef,
  SnapshotOf,
} from "effect-frame/actor";
import { CommandId as CommandIdSchema, Form, Generated, Wire } from "effect-frame/actor/client";
import { Effect, Option, Predicate, Ref, Schema } from "effect";
import type { HostEvent } from "./host.js";
import type { ElementNode, ElementProps, Node } from "./jsx-runtime.js";
import type { PlainPost, Prepared } from "./view.js";

/**
 * A form that sends one command (#21 §1). One binding serves every host:
 * the runtime writes its plain post as `method`, `action`, and hidden
 * inputs, so a server render posts with no script; a DOM host cancels the
 * native post and sends the same message over the transport instead.
 */
export interface CommandForm<C extends AnyContract, M, Typed extends string> {
  readonly ref: RemoteActorRef<C>;
  readonly contract: C;
  readonly key: KeyOf<C>;
  /**
   * The message member this form sends: one `TaggedStruct` of the
   * contract's union. A member field that no input carries, no mark
   * generates, and no default fills does not compile (#32).
   */
  readonly message: M & Form.Covered<M, Typed>;
  /** The member fields this form's own inputs carry, by name. */
  readonly typed: ReadonlyArray<Typed>;
  /** The actor base URL, as the client transport uses it: `/actors`. */
  readonly endpoint: string;
  /** Where the browser goes after the post. A root-relative path. */
  readonly returnTo: string;
  /**
   * This form's identity on the page, posted as `$form`. A refusal redraws
   * only the form it names. The default is the member's tag, so name a
   * form only when one page has two forms for one member on one key.
   */
  readonly name?: string;
  /** Runs after a scripted send, with its handle. A plain post never runs it. */
  readonly onSend?: (
    handle: IdentifiedCommandHandle<SnapshotOf<C>, "remote">,
  ) => Effect.Effect<unknown>;
}

/** What a view draws a command form with. */
export interface FormBinding {
  /** `<form onSubmit={binding.submit}>`. */
  readonly submit: Prepared;
  /** The issues of a refused post of this form. Empty on an ordinary render. */
  readonly issues: ReadonlyArray<Form.FormIssue>;
  /**
   * The id this render drew. On a server render it is the id the markup
   * carries. A hydrating client keeps the server's markup, so its first
   * send uses the markup's id, not this one.
   */
  readonly commandId: CommandId;
}

/** A message member: a schema whose type is one of the contract's messages. */
export type Member<C extends AnyContract> = Schema.Top & { readonly Type: MessageOf<C> };

const decodeCommandId = Schema.decodeUnknownOption(CommandIdSchema);

const onlyMember = (message: Schema.Top): Effect.Effect<Generated.Member> =>
  Option.match(Option.fromNullishOr(Generated.membersOf(message.ast)[0]), {
    onNone: () => Effect.die("View.form: the message is not a TaggedStruct"),
    onSome: Effect.succeed,
  });

/**
 * The generated values the render writes beside the command id. A value
 * derived from the command id follows it. A fresh one is kept from a
 * refused post only when the id was kept too: the server drops it from
 * `submitted` whenever it mints a new id.
 */
const renderGenerated = (
  member: Generated.Member,
  commandId: CommandId,
  kept: Form.FormFields,
): Effect.Effect<ReadonlyArray<readonly [string, string]>> =>
  Effect.forEach(member.generated, ([name, generation]) =>
    Effect.map(
      Option.match(Form.last(kept, name), {
        onNone: () => Generated.mint(generation, commandId),
        onSome: (value) => {
          if (generation._tag === "FromCommandId") {
            return Effect.succeed<string>(commandId);
          }
          return Effect.succeed(value);
        },
      }),
      (value): readonly [string, string] => [name, value],
    ),
  );

/**
 * Bind a form to one command. Run it in the view's setup: the render
 * chooses the command id here, and every generated field with it. A render
 * with a `FormContext` for this form (same contract, key, and `$form`)
 * takes the id the server chose instead:
 * fresh after a refusal, the same after a lost reply.
 *
 * On the client the binding adopts what the markup carries. Its first send
 * uses the `$command` and generated values in the form's hidden inputs,
 * which after hydration are the server's; it never mints over them. Each
 * later send from the same form mints a fresh id.
 */
export const form = <C extends AnyContract, M extends Member<C>, const Typed extends string>(
  options: CommandForm<C, M, Typed>,
): Effect.Effect<FormBinding> =>
  Effect.gen(function* () {
    const member = yield* onlyMember(options.message);
    const key = yield* Form.encodeKey(options.contract, options.key);
    const identity = Option.getOrElse(Option.fromNullishOr(options.name), () => member.tag);
    const context = Option.filter(
      yield* Effect.serviceOption(Form.FormContext),
      (issues) =>
        issues.contract === options.contract.name && issues.key === key && issues.form === identity,
    );
    const commandId = yield* Option.match(context, {
      onNone: () => Form.freshCommandId,
      onSome: (issues) => Effect.succeed(issues.commandId),
    });
    const kept = Option.match(context, {
      onNone: (): Form.FormFields => new Map(),
      onSome: (issues) => issues.submitted,
    });
    const generated = yield* renderGenerated(member, commandId, kept);
    const issues = Option.match(context, {
      onNone: (): ReadonlyArray<Form.FormIssue> => [],
      onSome: (found) => found.issues,
    });

    const post: PlainPost = {
      action: `${options.endpoint}${Wire.paths.form}`,
      method: "post",
      hidden: [
        [Form.frameworkFields.command, commandId],
        [Form.frameworkFields.contract, options.contract.name],
        [Form.frameworkFields.version, String(options.contract.version)],
        [Form.frameworkFields.key, key],
        [Form.frameworkFields.returnTo, options.returnTo],
        [Form.frameworkFields.form, identity],
        ["_tag", member.tag],
        ...generated,
      ],
      submitted: Form.without(
        kept,
        member.generated.map(([name]) => name),
      ),
      invalid: issues.map((issue) => issue.field),
    };

    const send = yield* scriptedSend(options, member);
    const handler = (event: HostEvent): Effect.Effect<void> =>
      Option.match(event.form, { onNone: () => Effect.void, onSome: send });

    return {
      submit: { _tag: "Prepared", preventDefault: true, handler, post: Option.some(post) },
      issues,
      commandId,
    };
  });

/**
 * The DOM half. The first send adopts the rendered identity; every later
 * one mints its own, with its generated values, in one step. A form the
 * client cannot decode sends nothing and logs why.
 */
const scriptedSend = <C extends AnyContract, M, Typed extends string>(
  options: CommandForm<C, M, Typed>,
  member: Generated.Member,
) =>
  Effect.gen(function* () {
    const spent = yield* Ref.make<ReadonlySet<string>>(new Set());
    const decodeTree = Schema.decodeUnknownEffect(options.contract.raw.message);
    const asMessage = Schema.decodeUnknownEffect(Schema.toType(options.contract.message));
    const onSend = Option.fromNullishOr(options.onSend);

    const identify = (fields: Form.FormFields) =>
      Effect.gen(function* () {
        const used = yield* Ref.get(spent);
        const adopted = Option.filter(
          Option.flatMap(Form.last(fields, Form.frameworkFields.command), decodeCommandId),
          (id) => !used.has(id),
        );
        if (Option.isSome(adopted)) {
          return { commandId: adopted.value, fields };
        }
        const commandId = yield* Form.freshCommandId;
        const minted = yield* Generated.mintAll(member, commandId);
        return { commandId, fields: Form.withValues(fields, minted) };
      });

    return (fields: Form.FormFields): Effect.Effect<void> =>
      Effect.gen(function* () {
        const identified = yield* identify(fields);
        yield* Ref.update(spent, (used) => new Set([...used, identified.commandId]));
        const nested = yield* Form.tree(Form.strip(identified.fields));
        const decoded = yield* decodeTree(nested);
        const message = yield* asMessage(decoded);
        const handle = yield* options.ref.send(message, { commandId: identified.commandId });
        yield* Option.match(onSend, {
          onNone: () => Effect.void,
          onSome: (run) => Effect.asVoid(run(handle)),
        });
      }).pipe(
        Effect.catch((error) => Effect.logWarning("View.form: the form did not decode", error)),
      );
  });

// ---------------------------------------------------------------------------
// Repopulation
// ---------------------------------------------------------------------------

const controls = new Set(["input", "textarea", "select"]);
const toggles = new Set(["checkbox", "radio"]);

const staticString = (props: ElementProps, name: string): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(props[name]), Predicate.isString);

/** A control a refused post named is marked for assistive technology. */
const invalidMark = (post: PlainPost, name: string): ReadonlyArray<readonly [string, string]> => {
  if (post.invalid.includes(name)) {
    return [["aria-invalid", "true"]];
  }
  return [];
};

/** The props a posted value overrides on one control. */
const overridesOf = (
  element: ElementNode,
  post: PlainPost,
  name: string,
): ReadonlyArray<readonly [string, string | boolean]> => {
  const values = Option.fromNullishOr(post.submitted.get(name));
  const invalid = invalidMark(post, name);
  const type = Option.getOrElse(staticString(element.props, "type"), () => "text");
  if (element.tag === "input" && toggles.has(type)) {
    const own = Option.getOrElse(staticString(element.props, "value"), () => "on");
    return [["checked", Option.exists(values, (posted) => posted.includes(own))], ...invalid];
  }
  if (element.tag === "textarea") {
    return invalid;
  }
  return Option.match(
    Option.flatMap(values, (posted) => Option.fromNullishOr(posted.at(-1))),
    {
      onNone: () => invalid,
      onSome: (value) => [["value", value], ...invalid],
    },
  );
};

/** A textarea draws its value as its text. */
const textOf = (element: ElementNode, post: PlainPost, name: string): Node =>
  Option.match(
    Option.flatMap(Option.fromNullishOr(post.submitted.get(name)), (posted) =>
      Option.fromNullishOr(posted.at(-1)),
    ),
    {
      onNone: () => element.children,
      onSome: (text): Node => ({ _tag: "Text", text }),
    },
  );

/** One control, redrawn from the posted values. */
const redraw = (element: ElementNode, post: PlainPost): ElementNode => {
  const name = staticString(element.props, "name");
  if (Option.isNone(name) || !controls.has(element.tag)) {
    return element;
  }
  const props: ElementProps = {
    ...element.props,
    ...Object.fromEntries(overridesOf(element, post, name.value)),
  };
  if (element.tag === "textarea") {
    return { ...element, props, children: textOf(element, post, name.value) };
  }
  return { ...element, props };
};

/**
 * Redraw a refused post into the form's own controls: each static
 * `input`, `textarea`, or `select` whose `name` was posted gets its value
 * back, and each named issue marks its control `aria-invalid`. Controls
 * inside a `For`, `Show`, or `Match` are drawn by their own setup and are
 * left alone. An ordinary render has nothing submitted and changes nothing.
 */
export const repopulate = (node: Node, post: PlainPost): Node => {
  if (post.submitted.size === 0 && post.invalid.length === 0) {
    return node;
  }
  if (node._tag === "List") {
    return { ...node, children: node.children.map((child) => repopulate(child, post)) };
  }
  if (node._tag === "Element") {
    const redrawn = redraw(node, post);
    return { ...redrawn, children: repopulate(redrawn.children, post) };
  }
  return node;
};
