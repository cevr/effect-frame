# Toolchain validation

Date: 2026-09-18.

This report covers the scaffold only. It does not prove actor, renderer, or celld behavior.

## Versions

The root manifest pins Bun 1.4.2 and Effect 4.0.0-rc.115.
The platform catalog uses the same Effect RC version.
The current npm `latest` tag still selects Effect 3.22.2.
The `rc` tag selects the verified v4 release.

Project Scaffolding requires `@effect/tsgo` at `^0.24.3`.
The lock resolves 0.24.3.
Its patch command succeeded with TypeScript 7.0.2.
The patch output identified the `typescript` platform package's `lib/tsc` binary.
The editor-only native-preview package was not the typecheck target.

Oxlint uses the complete recommended rule map from the installed `oxlint-plugin-effect` 0.12.1 package.
The skill's older twelve-rule example is not the current preset.
Host, script, and application paths do have lint escape hatches: per-file `overrides` in `.oxlintrc.json` and `oxlint-disable` comments with a reason. `bun run lint` passes `--report-unused-disable-directives-severity=error`, so a disable comment that no longer suppresses anything fails the gate.
The repository's own conventions are the `frame` plugin, `tooling/checks/src/lint-plugin.ts`, loaded beside the Effect plugin: `frame/no-switch` (branch with `Match`), `frame/disable-reason` (every `oxlint-disable` ends with ` -- <reason>`), and `frame/span-name` (an `Effect.fn` span is `Area.operation`). `import/no-cycle` and `unicorn/filename-case` (kebab case) are on too.
`bun run docs` holds the reference docs to the code. `CONTEXT.md` defines each term once (`tooling/checks/src/glossary.ts`), and every ts or tsx block in a reference doc is a marked region of a compiled file (`tooling/checks/src/examples.ts`); `bun run docs --fix` writes the blocks from their regions.
The `plugins` list names `unicorn` and `oxc` with the rest, because a `plugins` list replaces oxlint's default set. One of their rules is off by name: `unicorn/consistent-function-scoping`, which asks to hoist every closure that captures nothing. Effect code keeps a helper next to the one `Effect.gen` body, view, or test that uses it, and that rule flagged 59 such helpers and no defect.

## Checks

- `bun install`: passed. The compiler patch verified itself.
- `bun run gate`: passed lint, format checks, type checks, browser bundling, and tests.
- Compatibility tests: three passed. They check schema round-trip, a typed decode failure, and completion of a yielding finalizer.
- A temporary floating Effect probe failed `tsc` with `TS377001` and `effect(floatingEffect)`.
- A temporary ternary probe failed Oxlint with `effect(noTernary)`.
- Both temporary probes were removed after the negative checks.
- `bun pm ls --all`: one installed Effect version, 4.0.0-rc.115.
- The supplied CI template is unchanged. A second workflow checks build and formatting.

These checks prove the toolchain is active. They do not substitute for framework acceptance tests.

## Known warning

Bun reports an Effect peer warning for `effect-bun-test` 0.3.0.
That package declares `effect >=3.19.0`, which does not admit a v4 prerelease under normal semver rules.
Its default export uses Effect v4 source, and the installed package passes this scaffold's tests.
An upstream peer-range correction remains necessary. This project does not patch or republish that library.

## Source receipts

Project files:

- `package.json`
- `bun.lock`
- `tsconfig.json`
- `.oxlintrc.json`
- `turbo.json`
- The codec probe, `codec-probe.ts` in `tooling/checks/src`, removed on 2026-09-25 with its three compatibility tests. The toolchain test now checks the Bun version.
- `tooling/checks/tests/toolchain.test.ts`

Installed source:

- `node_modules/effect/src/Schema.ts`
- `node_modules/effect/src/Effect.ts`
- `node_modules/effect-bun-test/package.json`
- `node_modules/effect-bun-test/src/index.ts`
- The exported `oxlint-plugin-effect/presets/recommended` rule map.

Guidance:

- `/Users/cvr/Developer/personal/dotfiles/skills/project-scaffolding/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/project-scaffolding/references/monorepo.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/project-scaffolding/templates/tsconfig.json`
- `/Users/cvr/Developer/personal/dotfiles/skills/project-scaffolding/templates/turbo.json`
- `/Users/cvr/Developer/personal/dotfiles/skills/project-scaffolding/templates/ci.yml`

Version metadata came from the npm registry with `npm view` on the report date.
