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
 * - `frame/no-module-state`: a module holds no mutable state: no top-level
 *   `let`, and no top-level `new Map`, `Set`, `WeakMap`, or `WeakSet`
 *   unless an array literal fills it (a constant lookup table). State kept
 *   beside a value, keyed by it, is found by no reader of the value: carry
 *   it on the value, or in an actor or a Scope. `.oxlintrc.json` turns it on
 *   for `packages/*\/src`.
 * - `frame/explicit-ignore`: `Effect.ignore` and `Effect.ignoreCause` name
 *   `log` in their options (`{ log: "Warn", message }`, or `{ log: false }`
 *   when the failure is reported elsewhere). A failure dropped with no trace
 *   leaves nothing to read when it matters; the option makes dropping it a
 *   decision written where it is made.
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

interface MemberExpression extends LintNode {
  readonly object: LintNode & { readonly name?: string };
  readonly property: LintNode & { readonly name?: string };
}

interface ObjectExpression extends LintNode {
  readonly properties: ReadonlyArray<
    LintNode & { readonly key?: LintNode & { readonly name?: string; readonly value?: unknown } }
  >;
}

interface Declarator extends LintNode {
  readonly init?: LintNode & {
    readonly callee?: LintNode & { readonly name?: string };
    readonly arguments?: ReadonlyArray<LintNode>;
  };
}

interface Declaration extends LintNode {
  readonly kind?: string;
  readonly declarations?: ReadonlyArray<Declarator>;
  /** The declaration an `export` statement wraps. */
  readonly declaration?: Declaration;
}

interface Program extends LintNode {
  readonly body: ReadonlyArray<Declaration>;
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

/** The Effect combinators that drop a failure. */
const ignoring: ReadonlySet<string> = new Set(["ignore", "ignoreCause"]);

const isIgnore = (node: LintNode): node is MemberExpression => {
  if (node.type !== "MemberExpression") {
    return false;
  }
  const member: Partial<MemberExpression> = node;
  return (
    Option.exists(Option.fromNullishOr(member.object), (object) => object.name === "Effect") &&
    Option.exists(
      Option.flatMap(Option.fromNullishOr(member.property), (property) =>
        Option.fromNullishOr(property.name),
      ),
      (name) => ignoring.has(name),
    )
  );
};

/** An object literal with a `log` property. */
const namesLog = (node: LintNode): boolean => {
  if (node.type !== "ObjectExpression") {
    return false;
  }
  const options: Partial<ObjectExpression> = node;
  return Option.getOrElse(Option.fromNullishOr(options.properties), () => []).some((property) =>
    Option.exists(
      Option.fromNullishOr(property.key),
      (key) => key.name === "log" || key.value === "log",
    ),
  );
};

const explicitIgnore: Rule = {
  create: (context) => {
    // The `Effect.ignore` callees already judged as calls, so the member
    // visitor reports only a bare `Effect.ignore` (`pipe(Effect.ignore)`).
    const called = new WeakSet<LintNode>();
    const report = (node: LintNode) =>
      context.report({
        node,
        message:
          'Say whether a dropped failure is logged: Effect.ignore(effect, { log: "Warn", message }), or { log: false } when it is reported elsewhere.',
      });
    return {
      CallExpression: (node: CallExpression) => {
        if (!isIgnore(node.callee)) {
          return;
        }
        called.add(node.callee);
        if (!node.arguments.some(namesLog)) {
          report(node);
        }
      },
      MemberExpression: (node: MemberExpression) => {
        if (isIgnore(node) && !called.has(node)) {
          report(node);
        }
      },
    };
  },
};

/** The collections whose top-level instance is mutable state. */
const collections: ReadonlySet<string> = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

/** The variable declaration a top-level statement is, exported or not. */
const variablesOf = (statement: Declaration): Option.Option<Declaration> => {
  if (statement.type === "VariableDeclaration") {
    return Option.some(statement);
  }
  return Option.filter(
    Option.fromNullishOr(statement.declaration),
    (inner) => statement.type === "ExportNamedDeclaration" && inner.type === "VariableDeclaration",
  );
};

/** `new Map(...)`, `new Set(...)`, and the weak ones, not filled by an array literal. */
const isMutableCollection = (declarator: Declarator): boolean =>
  Option.exists(
    Option.filter(
      Option.fromNullishOr(declarator.init),
      (init) =>
        init.type === "NewExpression" &&
        Option.exists(
          Option.flatMap(Option.fromNullishOr(init.callee), (callee) =>
            Option.fromNullishOr(callee.name),
          ),
          (name) => collections.has(name),
        ),
    ),
    (init) => {
      const first = Option.flatMap(Option.fromNullishOr(init.arguments), (given) =>
        Option.fromNullishOr(given[0]),
      );
      return !Option.exists(first, (argument) => argument.type === "ArrayExpression");
    },
  );

const noModuleState: Rule = {
  create: (context) => ({
    Program: (program: Program) => {
      for (const declaration of program.body.flatMap((statement) =>
        Option.toArray(variablesOf(statement)),
      )) {
        if (declaration.kind !== "const") {
          context.report({
            node: declaration,
            message:
              "A module holds no mutable binding: make it a const, or keep the state in an actor, a Scope, or on the value it describes.",
          });
        }
        const declarators = Option.getOrElse(
          Option.fromNullishOr(declaration.declarations),
          (): ReadonlyArray<Declarator> => [],
        );
        for (const declarator of declarators) {
          if (isMutableCollection(declarator)) {
            context.report({
              node: declarator,
              message:
                "A module-level Map, Set, WeakMap, or WeakSet is state no reader of its key can find: carry the data on the value, or in an actor or a Scope. A constant lookup table is filled by an array literal.",
            });
          }
        }
      }
    },
  }),
};

const plugin = {
  meta: { name: "frame" },
  rules: {
    "no-switch": noSwitch,
    "disable-reason": disableReason,
    "span-name": spanNameRule,
    "no-module-state": noModuleState,
    "explicit-ignore": explicitIgnore,
  },
};

export default plugin;
