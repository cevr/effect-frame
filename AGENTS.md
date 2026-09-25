# Working in effect-frame

This file is for anyone changing this repository, agent or human.
`CLAUDE.md` is a link to it.

## Read first

1. [`packages/effect-frame/README.md`](packages/effect-frame/README.md): the
   API as an app uses it. Its code blocks are the files in
   `packages/effect-frame/examples/`, which the gate compiles and tests.
2. [`CONTEXT.md`](CONTEXT.md): the glossary. Use its words, and its words
   only, in code, docs and commit messages.
3. The JSDoc of the module you change. It is the reference for that module.

`docs/design/` holds decision records: why a design is what it is, as of the
day it was written. They quote code as it was then. Do not copy code from
them; do not treat them as the reference.

## The gate

Bun 1.4.2 is required. The gate checks it first (`bun run toolchain`) and
stops on another version, naming the binary that ran.

```sh
bun install
bun run gate
```

The gate checks the Bun version, then runs three lanes, then the tests:

- types: `tsc` over every workspace, with the Effect language service.
- style: `oxlint`, `oxfmt --check`, `bun run paths` (every path a doc cites
  exists), and `bun run docs` (the glossary defines each term once, every
  ts or tsx block in a reference doc is a compiled example region, and no
  changeset takes a package to 1.0 by accident).
- build: the package build, the browser bundles, `bun run boundary`, and
  `bun run declarations`.

The pre-commit hook runs `bun run lint:fix`, `bun run fmt`, and the gate;
the `commit-msg` hook checks the Conventional Commits type.
Never skip it. Run `oxfmt` and `lint:fix` on your files first, so the hook
rewrites nothing.

## Code rules

The lint is strict and the rules are written down in `.oxlintrc.json`:

- No `switch`: branch with `Match` (`frame/no-switch`).
- No module-level mutable state in `packages/*/src`: no top-level `let`,
  and no top-level `Map`, `Set`, `WeakMap`, or `WeakSet` unless an array
  literal fills it. Carry data on the value it describes, or in an actor or
  a Scope (`frame/no-module-state`).
- App and example code (`apps/*/src`, `packages/effect-frame/examples`)
  holds state only in actors: it imports no `Ref`, `SubscriptionRef`,
  `SynchronizedRef`, `MutableRef`, `TxRef`, or `TxSubscriptionRef`. Use
  `Actor.local(Behavior.value(initial))` (`no-restricted-imports`).
- No `null` or `undefined` checks: use `Option` (`effect/noNullish`).
- No `typeof`: use `Predicate` (`effect/noRuntimeTypeof`).
- No Node builtins, no globals, no `as`, no thrown errors outside a written
  edge. An edge disables the rule on the line with a reason:
  `// oxlint-disable-next-line <rule> -- <why this is the edge>`. A disable
  without ` -- reason` fails `frame/disable-reason`.
- An `Effect.fn` span is `Area.operation`, such as `Query.run`
  (`frame/span-name`).
- `Effect.ignore` and `Effect.ignoreCause` say whether the failure is
  logged: `{ log: "Warn", message }`, or `{ log: false }` when the failure
  is reported elsewhere (`frame/explicit-ignore`).
- File names are kebab case. No import cycles.
- `Effect.provide` with a Layer appears only at an entry point, with
  `// @effect-diagnostics-next-line strictEffectProvide:off`.

## The server/client boundary

- A file that may run only on a server is named `*.server.ts` or
  `*.server.tsx`. A file with no suffix runs in both places.
- A browser entry imports `effect-frame/actor/client`, never
  `effect-frame/actor`, and reaches no server module through any chain of
  imports. Every browser entry is listed in
  `tooling/checks/src/browser-entries.ts`; `bun run boundary` walks each
  one's graph. A new entry is added there. See
  [the boundary rule](docs/design/boundary.md).
- A value has one import path. `bun run declarations` refuses a value a
  reader can reach by two.

## Docs

- A ts or tsx block in a reference doc (`README.md`, `AGENTS.md`,
  `CONTEXT.md`, `docs/toolchain.md`, a package or app README, a skill) is a
  region of a compiled file. Mark it with the comment line
  `<!-- example: path#region -->` above the block, where `path` is relative
  to the doc, and wrap the source in `// #region name` and
  `// #endregion name`. `bun run docs --fix` writes every marked block from
  its region; `bun run docs` fails on a block that drifted or has no marker.
- An `@example` block in the JSDoc of `packages/*/src` is held the same way.
  The tag names the region, ` * @example path#region`, with `path` relative
  to the source file; the JSDoc examples live in
  `packages/effect-frame/examples/reference/`. A JSDoc block with no
  `@example` tag is prose.
- A new example lives in `packages/effect-frame/examples/`, and a test in
  `packages/effect-frame/tests/examples/` runs what it can.
- A term is defined once, in `CONTEXT.md`, with the code that holds it.
- A doc cites only paths the tree holds (`bun run paths`).

## Changes

- Commits follow Conventional Commits. A breaking change has `!`. The
  `commit-msg` hook refuses a subject with no type
  (`tooling/checks/src/commit-message.ts`).
- A change to a published package carries a changeset in `.changeset/`. CI
  runs `changeset status --since=origin/main` on a pull request: a change
  to `src/**` or `package.json` of `effect-frame` with no changeset turns
  it red. A change that needs no release takes `changeset add --empty`.
- A package below 1.0 takes no `major` changeset: a breaking change on 0.x
  is `minor`. The first major release is the owner's decision, written by
  setting `firstMajor` in `tooling/checks/src/changesets.ts`; until then
  `bun run docs` refuses the bump and a published package at 1.0.
- A new check gets a test that fails before the check exists.
- A row of `docs/design/acceptance.md` moves only with the test that proves
  it.

## Where facts live

| Fact                                  | Place                                             |
| ------------------------------------- | ------------------------------------------------- |
| what a function does                  | its JSDoc                                         |
| how an app uses the API               | `packages/effect-frame/README.md` and `examples/` |
| what a word means                     | `CONTEXT.md`                                      |
| why a design was chosen               | `docs/design/`                                    |
| what the toolchain is and checks      | `docs/toolchain.md`                               |
| scope and open questions              | the GitHub map, issue #1                          |
| the architecture loop's working notes | `plans/`                                          |
