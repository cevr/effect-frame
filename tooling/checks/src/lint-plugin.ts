import { Option, Predicate } from "effect";

/**
 * The repository's own lint rules, loaded by `.oxlintrc.json` as the
 * `frame` plugin. Each one turns a convention the code already keeps into a
 * rule the build checks, so an agent learns it from the first error rather
 * than from a reviewer.
 *
 * - `frame/no-switch`: branch on a tagged value with `Match.tagsExhaustive`
 *   (or `Match.value`), never `switch`. A `switch` compiles with a missing
 *   case; `Match.tagsExhaustive` does not.
 * - `frame/disable-reason`: every `oxlint-disable` comment says why after
 *   ` -- `, so an exemption is a written decision that a reader can check.
 * - `frame/span-name`: an `Effect.fn` span is named `Area.operation`
 *   (`Notes.renderPage`, `Actor.durable.process`), so a trace reads as one
 *   vocabulary.
 */

/** The part of a node the rules read. */
interface LintNode {
  readonly type: string;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

interface Comment {
  readonly type: string;
  readonly value: string;
  readonly loc: { readonly start: Position; readonly end: Position };
}

interface CallExpression extends LintNode {
  readonly callee: LintNode & {
    readonly object?: LintNode & { readonly name?: string };
    readonly property?: LintNode & { readonly name?: string };
  };
  readonly arguments: ReadonlyArray<LintNode & { readonly value?: unknown }>;
}

type Report =
  | { readonly node: LintNode; readonly message: string }
  | { readonly loc: Comment["loc"]; readonly message: string };

interface Context {
  readonly report: (report: Report) => void;
  readonly sourceCode: { readonly getAllComments: () => ReadonlyArray<Comment> };
}

interface Rule {
  readonly create: (context: Context) => Readonly<Record<string, (node: never) => void>>;
}

/** The form of a span name: an area, then one or more lowercase operations. */
export const spanName = /^[A-Z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;

/** An `oxlint-disable` directive, and whether it carries ` -- reason`. */
const directive = /^\s*oxlint-disable(?:-next-line|-line)?\b/;
const reasoned = /\s--\s+\S/;

const noSwitch: Rule = {
  create: (context) => ({
    SwitchStatement: (node: LintNode) => {
      context.report({
        node,
        message:
          "Branch with Match.tagsExhaustive (or Match.value) from effect, not switch: a missing case then does not compile.",
      });
    },
  }),
};

const disableReason: Rule = {
  create: (context) => ({
    Program: () => {
      for (const comment of context.sourceCode.getAllComments()) {
        if (directive.test(comment.value) && !reasoned.test(comment.value)) {
          context.report({
            loc: comment.loc,
            message:
              "Say why this rule is off: end the directive with ` -- <reason>`, or delete it.",
          });
        }
      }
    },
  }),
};

const isEffectFn = (node: CallExpression): boolean =>
  node.callee.type === "MemberExpression" &&
  Option.exists(Option.fromNullishOr(node.callee.object), (object) => object.name === "Effect") &&
  Option.exists(Option.fromNullishOr(node.callee.property), (property) => property.name === "fn");

const spanNameRule: Rule = {
  create: (context) => ({
    CallExpression: (node: CallExpression) => {
      if (!isEffectFn(node)) {
        return;
      }
      const first = Option.fromNullishOr(node.arguments[0]);
      Option.map(first, (argument) => {
        if (
          argument.type === "Literal" &&
          Option.exists(
            Option.liftPredicate(argument.value, Predicate.isString),
            (name) => !spanName.test(name),
          )
        ) {
          context.report({
            node: argument,
            message: `Name the span Area.operation, as ${"`Notes.renderPage`"}: an area in PascalCase, then lowercase operations.`,
          });
        }
      });
    },
  }),
};

const plugin = {
  meta: { name: "frame" },
  rules: {
    "no-switch": noSwitch,
    "disable-reason": disableReason,
    "span-name": spanNameRule,
  },
};

export default plugin;
