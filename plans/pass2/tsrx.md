# Architecture pass 2: TSRX as a template syntax (seed T1)

Scope: an evaluation of TSRX (https://tsrx.dev/) as the view syntax for effect-frame, compared with the current JSX. Read-only. This file is the only repository file written.

Sources:

- TSRX: `~/.cache/repo/tsrx-org/tsrx` at `d3dc6bab` (2026-09-25). It is a **shallow clone**: `git rev-parse --is-shallow-repository` returns `true`, so the history numbers below come from the GitHub API, not from `git log`.
- effect-frame: this worktree (`arch-pass2`).
- The consumer: `bible-tools/apps/egw-search/src/app.tsx`.

Receipt paths are relative to the TSRX repository root unless they start with `ef:`, which means this worktree, or `egw:`, which means `bible-tools/apps/egw-search/src/`.

Probes were run under `scratchpad/pass2-tsrx/`. **The TSRX compiler itself could not be run.** `@tsrx/core` imports `@sveltejs/acorn-typescript` (`packages/tsrx/src/parse/index.js:10`). That package is not in any local `node_modules` or Bun cache, and the task did not allow a network install. Every claim below about compiler output therefore comes from reading the source or the tests. Claims that no test or source line settles are marked **unverified**.

---

## Verdict first

| Question | Short answer |
| -------- | ------------ |
| Can the syntax hold an effect-frame view? | Mostly. Generators and `yield*` are supported. `return @{ … }` inside `Effect.gen` is valid by the grammar. |
| Does `@if` or `@for` fix F1 or F3? | No. `@if` has no binder, so it cannot pass on a narrowed `Source<B>`, and `Reference` needs exactly that. `{…}` still needs `View.bind`. |
| Would the gate check `.tsrx`? | No. TSRX type-checking runs on classic TypeScript through Volar. effect-frame's `tsc` is TypeScript 7.0.2, the Go build patched by `@effect/tsgo`. TSRX's VS Code extension says TS Go is not supported, and the TS7 issue (#38) is open. oxlint and oxfmt skip `.tsrx` files. |
| Maturity | Beta, about one month public: `@tsrx/core` 0.4.0, 122 open issues, several of them open generator bugs. |
| Recommendation | **(b)** Stay on JSX. Take two ideas as JSX or API changes: a flat union `Match`, and derived sources named beside the markup. Revisit TSRX when #38 (TS7) closes. |

---

## 1. Syntax, semantics, and the target plugin

### Syntax

- **Statement container `@{ … }`.** The grammar is `JSXCodeBlock : @{ TemplateSetupListopt TemplateOutput JSXStyleElementListopt }` (`website-tsrx/src/pages/specification.tsrx:78-79`). Setup statements come first, then exactly one output node: an element, a fragment, or a control-flow expression (`specification.tsrx:31-37`; `website-tsrx/public/llms.txt:598-613`). In the AST it is `JSXCodeBlock { body: StatementListItem[]; render: TemplateOutput }` (`specification.tsrx:408-412`). A container is a `PrimaryExpression` (`specification.tsrx:1-9`), so `const v = @{ …; <span/> }` is legal (`llms.txt:643-650`). A statement after the output is a parse error (`packages/tsrx/src/plugin.js:1797`).
- **Function entry.** `function f(…) JSXCodeBlock` for declarations and function expressions, plus `return JSXCodeBlock ;` (`specification.tsrx:43-56`). Arrow bodies may also be code blocks: the parser's `parseFunctionBody` override accepts `@{` for "a function, method, or arrow function" (`packages/tsrx/src/plugin.js:4048-4072`).
- **Control flow.** `@if (Expression) TemplateBlock [@else …]`, `@for (ForHeader TemplateForOptions) TemplateBlock [@empty TemplateBlock]`, `@switch`/`@case`/`@default`, and `@try … @pending|@catch` (`specification.tsrx:92-111`). Each is an expression, not a statement (`llms.txt:730-738`). A `@for` loop over `for…of` takes `; index i; key expr` (`llms.txt:752-770`); `key` is stored as `JSXForExpression.key?: Expression` (`specification.tsrx:447-459`). Direct `return`, `break`, and `continue` inside template bodies are rejected (`llms.txt:733-737`, `llms.txt:765-770`); guard `return`s go before the output as ordinary JS (`llms.txt:821-838`).
- **Locals.** Any statement may go in the setup of `@{}`, or in any control-flow body, which is an implicit statement container (`llms.txt:735-738`, `1479-1492`).
- **`<style>`.** Scoped to siblings: it styles its siblings and everything below them. The compiler stamps a hash class on those elements. `const t = <style>…</style>` yields a theme with `$class`, which is applied with `<style apply={t}/>`, and `@import` is an error (`AGENTS.md` "Authoring Assumptions"; `llms.txt:840-1371`; grammar at `specification.tsrx:114-129`).
- **What a construct means depends on the target.** "The compiler transforms the same source differently per target — e.g. `@if` lowers to `<Show>` on Solid, an IIFE + conditional return on React/Preact" (`llms.txt:540-543`).

### How a target gets the AST and emits code

- **The pipeline.** A target's `compile` runs `parseModule`, then `specializePlatform`, then `analyzeTsrx`, then its own `transform`, and returns `{ code, map, css, … }` (`packages/tsrx-solid/src/index.js:41-67`; `CompileResult` at `packages/tsrx/types/index.d.ts:2260-2271`). A second entry, `compile_to_volar_mappings`, emits type-only TSX plus Volar mappings for editors (`tsrx-solid/src/index.js:70-122`).
- **A JSX-emitting target is a descriptor.** It is `createJsxTransform(platform)` (`packages/tsrx/src/transform/jsx/index.js:553`) with a `JsxPlatform` object: import sources, JSX spelling, validation, and `hooks`. The hooks include `controlFlow.{ifStatement, forOf, switchStatement, tryStatement}`, each mapping a TSRX statement node to a JSX render node (`packages/tsrx/types/jsx-platform.d.ts:155-170`). They also include `validateComponentAwait`, `injectImports`, and `transformElement` (`jsx-platform.d.ts:295-340`).
- **A third-party compiler plugs into the editor tooling.** `tsconfig.json` names it as `"tsrx": { "compiler": "<bare package>" }`, and "a third-party TSRX compiler" is explicitly allowed (`packages/typescript-plugin/README.md` "Configuration"; the bare-specifier check is at `typescript-plugin/src/consumer-compiler.js:52`, `285-288`). The compiler module must export `compile_to_volar_mappings`, and optionally `compile` (`typescript-plugin/src/language.js:5`).

### Target sizes (source lines, `src/` only, `wc -l`)

| Package | LOC | Version (`package.json`) |
| ------- | --- | ------------------------ |
| `@tsrx/core` (`packages/tsrx`) | 30,220 (`plugin.js` 5,933; `transform/jsx/index.js` 6,976) | 0.4.0 |
| `@tsrx/react` | 169 (`transform.js` is 45: descriptor only) | 0.3.9 |
| `@tsrx/solid` | 2,350 (`transform.js` 2,227) | 0.2.9 |
| `@tsrx/solid-runtime` | 1 | 0.1.12 |
| `@tsrx/vue` | 1,561 | 0.2.9 |
| `@tsrx/hono` | 581 | 0.1.8 |
| `@tsrx/bun-plugin-solid` | 170 | 0.0.75 |
| `@tsrx/typescript-plugin` | 2,389 | 0.4.12 |
| `@tsrx/language-server` | 3,114 | 0.4.12 |

React can be 45 lines because the core's default lowering re-evaluates everything on each render, which is React's model. Solid is setup-once, like effect-frame, and needs its own lowering of every control-flow form to `<Show>`, `<For>`, `<Switch>/<Match>`, and `<Errored>/<Loading>` (`tsrx-solid/src/transform.js:70-175`, `907-1076`, `1461-1475`). An effect-frame target is in the Solid class, not the React class.

---

## 2. Generators, `yield*`, and `Effect.gen`

- **The grammar lists no generator form.** `FunctionDeclaration`/`FunctionExpression … JSXCodeBlock` has no `function*` production (`specification.tsrx:43-50`). However, the parser override is generic: `parseFunctionBody` accepts `@{` whatever flags acorn already set, including the generator flag (`plugin.js:4048-4063`). The code block opens a block scope, not a function scope (`this.enterScope(0)`, `plugin.js:1844`), so a `yield` inside `@{}` sees the enclosing generator. **Whether `function* () @{ … }` parses is unverified**, because the compiler could not be run.
- **`return @{ … }` inside a generator is in the grammar** (`specification.tsrx:52-56`). So this form is legal TSRX by the spec:

  ```tsx
  Effect.gen(function* () {
    const x = yield* Actor.local(...);
    return @{ const y = …; <div>{View.bind(x.state)}</div> };
  })
  ```

- **`yield` inside templates is a supported feature.** The core rewrites a generated IIFE that holds an authored `yield` into `yield* (function* () { … })()`, and reports a `yield` it cannot delegate, such as one in a callback child (`transform/jsx/index.js:2948-2980`). Tests cover `yield` in `@switch` cases and in `@if` branches with setup inside `export function* chart(…)` (`packages/tsrx/tests/utils/type-only-jsx-analysis.test.js:210-246`, `468-500`), and they type-check the output with TypeScript for TS1163 and TS7057.
- **The generator paths still have open bugs.** Issue numbers come from `gh api repos/tsrx-org/tsrx/issues/N`:
  - #259: "Solid and Vue fail with a parse error in compiled output for a yield inside JSX". This is inherent to fine-grained targets: the framework's JSX compiler moves the expression into a closure.
  - #257: diagnostics at an authored `yield` are dropped because `yield` is never mapped.
  - #265: async `yield*` inside template closures throws "not iterable".
  - #264, #261, #502: generated generator closures lose `this` or `arguments`.
- **What this means for effect-frame.** In a setup-once lowering, an `@if` or `@for` body becomes a render callback, as it does for Solid (`tsrx-solid/src/transform.js:364-371`). A `yield*` there would be reported, not delegated (`transform/jsx/index.js:2970-2974`). That matches effect-frame's rule that a branch or row setup which runs Effects goes through `View.list` or `View.keyed` (ef:`packages/effect-frame/src/view/control.ts:30-60`). Effects stay in the setup before the `@{}` output, not inside template bodies.

**An effect-frame view in TSRX (sketch, not compiled):**

```tsx
export const Greeting = (props: { readonly greeting: string }) =>
  Effect.gen(function* () {
    const name = yield* Actor.local(Behavior.value(""));
    const type = View.event((event) => Effect.asVoid(name.send(Value.Set(event.value))));
    return @{
      const greeting = View.bind(name.state, (text) => `${props.greeting}, ${text}`);
      <label>
        name <input value={View.bind(name.state)} onInput={type} />
        <output>{greeting}</output>
      </label>
    };
  });
```

The `@{}` adds nothing here: the setup already sits in `Effect.gen` before the `return`. Compare ef:`packages/effect-frame/src/view/view.ts:145-167`, which is the same shape in `.tsx`.

---

## 3. Reactivity: implicit in Solid, and how an explicit form would fit

- **In tsrx-solid, `@if (cond)` is `<Show when={cond}>` verbatim.** `build_show_element` puts the test expression into `when={…}` (`tsrx-solid/src/transform.js:1007-1014`), and `@for` becomes `<For each={right} keyed={(item) => key}>` (`transform.js:1034-1076`). TSRX itself tracks nothing. The tracking is implicit and comes from `babel-preset-solid`, which wraps JSX expressions in getters (`packages/bun-plugin-solid/src/index.js:74-95`; issue #259 describes that closure wrapping). Plain `if` or `switch` in the setup stays setup-once; only the `@` directives are lifted into reactive forms (`transform.js:1461-1475`).
- **The semantics come from the target.** An effect-frame target could lower `@if (X)` to ef's `<Show when={X}>` and `@for (const x of S; key k)` to `<For each={S} keyBy={(x) => k}>{(x) => …}</For>`.
- **The type layer would enforce explicit Sources for free, but only in editors.** The Volar path type-checks the target's emitted TSX (`typescript-plugin/src/language.js:5`). ef's `Show.when` is `Source<boolean>` or `Source<A>` (ef:`control.ts:94-117`), and `For.each` is `Source<ReadonlyArray<Item>>` (ef:`control.ts:15-20`). So `@if (flag)` with a plain boolean, or `@for` over a plain array, would be a type error at the `@if` or `@for` site through the mappings. **Unverified**: that a diagnostic on a generated `when=` maps back to the `@if` test span.
- **`@if (View.when(source, pred))` fits the grammar**, since the test is any `Expression` (`specification.tsrx:92-95`). The target would lower it to `<Show when={src} is={pred}>`. A syntactic check that the test is a `View.when(…)` call is possible in `analyze`, but the type check above already does the job.
- **The gap: `@if` binds no name.** `JSXIfExpression` is `{ test, consequent, alternate }` (`specification.tsrx:432-438`). ef's narrowing `Show` hands the branch a `Source<B>` that exists only while the branch is shown (ef:`control.ts:100-117`; CONTEXT "Shown branch"). TSRX has no syntax to name that value, and `Reference` (egw:`app.tsx:807-827`) needs it twice. `@switch`/`@case` binds nothing either (`specification.tsrx:101-106`). Two ways out:
  - Misuse `@for` over a 0-or-1 list, which does bind.
  - Keep ef's `<Show>` and `<Match>` tags. Both remain legal JSX inside TSRX.
- **`@for` gives one identifier two types.** In ef, a row receives `Source<Item>` (ef:`control.ts:19`), but `key x.id` is evaluated on the raw `Item`. In `@for (const p of S; key p.key) { …View.bind(p)… }`, `p` would be an `Item` in the key clause and a `Source<Item>` in the body. This conflicts with "explicit over implicit".

---

## 4. Types and diagnostics

- **Mechanism.** Checking is Volar-based. `@tsrx/typescript-plugin` depends on `@volar/language-core` and `@volar/typescript` (`typescript-plugin/package.json:28-31`). It asks the target compiler for virtual TSX and maps results back (`typescript-plugin/README.md` intro). The language server is `@volar/language-server` plus `volar-service-typescript` (`language-server/package.json:44-52`).
- **The CLI.** `tsrx-tsc` is Volar's `runTsc` over `require.resolve('typescript/lib/tsc.js')`, patching the JS compiler to accept `.tsrx` (`typescript-plugin/src/tsc.js:9-12`, `34-55`).
- **Not on TS7.** The VS Code extension says: "TypeScript Native Preview (TS Go) is not supported for .tsrx modules" (`packages/vscode-plugin/src/extension.js:60-61`). Issue #38, "Add native TypeScript 7 support via content mappers", is open (created 2026-09-01) and says the tooling "depend[s] on classic TypeScript's JavaScript API through Volar".
- **effect-frame's gate cannot host it as is.**
  - `typescript` is `7.0.2` (ef:`package.json:45`). `tsc -v` prints `Version 7.0.2+effect-tsgo.0.24.3`.
  - `typescript/lib/tsc.js` is a 609-byte launcher that `execve`s the Go binary (probe: `wc -c`, `head`). Volar's patch-the-JS-`tsc` approach has nothing to patch there.
  - Probe: a tsconfig that includes only `probe.tsrx` makes TS7 `tsc` report `TS18003: No inputs were found`, so `.tsrx` files are invisible to the gate.
- **Effect language service.** In effect-frame it runs as the `@effect/tsgo` patch of TS7 (ef:`package.json:26`, `docs/toolchain.md:14-18`, and the tsconfig `plugins` entry at ef:`tsconfig.json:15-40`). It would not see `.tsrx`. Running it would need a second, classic TypeScript install (5.x/6.x JS), `tsrx-tsc`, and the classic `@effect/language-service` plugin in that program. **Unverified** that the classic Effect plugin and Volar's `runTsc` compose. Effect diagnostics would then land on the virtual TSX, and their spans map back only where TSRX maps tokens: #257 shows `yield` has no mapping.
- **oxlint and oxfmt.** Probes with the worktree's oxlint 1.83.0 and oxfmt 0.68.0:
  - `oxlint probe.tsrx` prints "No files found to lint".
  - `oxfmt --check probe.tsrx` prints "Expected at least one target file".
  - The same source renamed to `.tsx` fails to parse at the `@{` (`probe.tsx:1:47`).

  TSRX ships only Prettier and ESLint integrations (`packages/prettier-plugin`, `eslint-parser`, `eslint-plugin`; `AGENTS.md` monorepo map). No oxc support exists; `grep -ri oxlint` over the repo finds none. So `effect/noNullish`, `effect/noTernary`, `frame/no-switch`, and the other lint rules (ef:`AGENTS.md` "Code rules") would not apply to view files. The `bun run docs` example-region check would not either.

---

## 5. Build

- **The Bun plugin (Solid)** is 170 LOC at version 0.0.75. `onLoad` for `.tsrx` calls `compile`, then Babel with `babel-preset-solid` and `@babel/preset-typescript`, and returns `loader: 'js'` (`bun-plugin-solid/src/index.js:74-95`, `143-164`). CSS is served as a virtual `?tsrx-css&lang.css` module (`index.js:16-17`, `136-155`).
- **Source maps are dropped.** `compile` returns a `map` (`types/index.d.ts:2264`), but the plugin keeps only `{ code, css }` (`index.js:147`). Babel runs with `sourceMaps: true` (`index.js:81`), but the plugin returns `result?.code` only (`index.js:94`). So stack traces point at the compiled JS. An effect-frame plugin could avoid this by inlining the map, **unverified** for Bun.
- **Babel is not needed for effect-frame.** ef's JSX is the automatic runtime producing data (ef:`packages/effect-frame/src/view/jsx-runtime.ts:185-196`). An effect-frame plugin could return TSX with `loader: 'tsx'` and let Bun's transpiler apply `jsxImportSource` (**unverified**).
- **SSR belongs to effect-frame, not TSRX.** Output is a plain ef node tree, which the Html and OpenTUI hosts already walk. TSRX's own SSR work (Hono `server-module.js`, 576 LOC; Octane hydration, `llms.txt:1433-1441`) is irrelevant. Two host-specific costs remain:
  - `<style>` stamps `class` hashes. OpenTUI intrinsics (`box`, `text`, `input`) have no class, so a terminal `.tsrx` file must reject `<style>`.
  - The server document would need to link the virtual CSS module.
- **F5 (per-file JSX runtime).** TSRX picks one compiler per tsconfig project (`typescript-plugin/README.md` "Configuration"). The `@jsxImportSource effect-frame/view/opentui` pragma would have to be read by the effect-frame compiler itself.

---

## 6. Maturity

| Fact | Value | Receipt |
| ---- | ----- | ------- |
| Status | "TSRX is in active beta development." | `README.md:39` |
| Core version | `@tsrx/core` 0.4.0; Solid 0.2.9; Bun Solid plugin 0.0.75 | `packages/*/package.json` |
| GitHub repo created | 2026-08-24 | `gh api repos/tsrx-org/tsrx` |
| Stars / forks | 162 / 13 | same |
| Open issues / PRs | 122 / 10 | `gh api search/issues` |
| Contributors | 55. Top: leonidaz 741 commits, trueadm (Dominic Gannaway) 628, bot 165, then under 30 each | `gh api …/contributors` |
| Activity | 83 commits since 2026-09-18; last push 2026-09-25; releases on 2026-09-25 | `gh api …/commits?since=`, `…/releases` |
| License | MIT | `LICENSE`, `package.json` |
| Language churn | Blog posts on removing and simplifying syntax ("removing-lazy-destructuring", "rethinking-tsrx", "simplifying-tsrx-after-feedback") | `website-tsrx/src/pages/` |

The repository has about 1,400 commits but was created on 2026-08-24, so the history was probably imported from Ripple (`AGENTS.md`: "Ripple is one supported target"). **Unverified.** Two people carry the project.

---

## 7. Verdict per north star, and the two options

### North stars

| North star | TSRX with an effect-frame target | Receipt |
| ---------- | -------------------------------- | ------- |
| Effect-native | **Neutral to negative.** Views stay `Effect.gen`, and `yield*` stays in the setup. Template-level `yield` is a feature with open bugs (#257, #259, #265). Nothing in it is Effect-aware. | §2 |
| Actor-model | **Neutral.** It is syntax only; it touches no state path. | |
| Expressive | **Slightly positive for plain conditionals, negative for the cases that matter.** `@if (View.when(s, p)) { … }` equals `<Show when={s} is={p}>…</Show>` in length, and `@empty` reads well. But narrowing (`Reference`) has no binder, and `@for`'s identifier changes type between the key and the body. | §3 |
| Declarative | **Neutral.** | |
| Explicit over implicit | **Negative in the toolchain; neutral in syntax if the target demands Sources.** The type rules hold only through the Volar editor path. The gate's `tsc` (TS7), oxlint, oxfmt, and the Effect diagnostics do not see `.tsrx` files, so "a mistake the types could catch" reaches CI unchecked. Scoped `<style>` also adds hidden hash classes to host nodes. | §4, §5 |

"Expressive never beats explicit" (`.claude/skills/architecture-loop/north-stars.md`). The toolchain gap alone rejects adopting TSRX today.

### Option (a): adopt TSRX with an effect-frame target

**What the framework would own:**

1. **`@effect-frame/tsrx`, a `JsxPlatform` descriptor plus control-flow lowering. Estimate 800 to 1,500 LOC.** This is below Solid's 2,227 because:
   - ef has no `Errored`/`Loading` tags; `View.loading` and `View.errored` are yielded Effects (ef:`README.md:490-513`), so `@try` is rejected.
   - The lowering targets ef's own `Show`, `For`, and `Match`.

   It must also:
   - reject `yield` and `await` in template bodies;
   - check or document the `key` versus `Source<Item>` split;
   - reject `<style>` under OpenTUI;
   - read `@jsxImportSource`;
   - export `compile_to_volar_mappings`.
2. **A Bun plugin**, about 100 LOC, with an inline source map.
3. **A second type-checker lane**: classic TypeScript, `tsrx-tsc`, and the classic Effect language service, until #38 lands. That means two TypeScript versions in one repository. **Unverified** that it works at all.
4. **Lint and format for `.tsrx`**: either ESLint and Prettier plugins beside oxlint and oxfmt, which breaks ef's toolchain choice (`docs/toolchain.md`), or linting the compiled TSX, where diagnostics point at generated code.
5. **A beta dependency** on about 30k lines of core parser and transform code maintained by two people, plus tracking its syntax churn.

**Mapping:**

| TSRX | effect-frame |
| ---- | ------------ |
| `@if (S) {A} @else {B}` (`S: Source<boolean>`) | `<Show when={S} fallback={B}>{A}</Show>` |
| `@if (View.when(S, p)) {…}` | `<Show when={S} is={p}>{…}</Show>` (no binder) |
| `@for (const x of S; key k) {…} @empty {E}` | `<For each={S} keyBy={(x) => k}>{(x) => …}</For>` with a fallback (ef `For` has no `fallback` today) |
| `@switch (S) { @case … }` | not mappable to `Match`: `@case` takes a value, not a tag, and binds nothing. Reject it. |
| `@try` | reject: boundaries are yielded Effects |

**`Reference` ported (sketch, not compiled).** It needs a binder, so it either misuses `@for` over a 0-or-1 list (`View.present` would be a new helper) or keeps `<Show>`:

```tsx
const Reference = (props: RefProps): Node =>
  @for (const refcode of View.present(props.refcode); key "ref") {
    @for (const url of View.present(props.url); key "url") {
      <a class={props.class} href={View.bind(url)} target="_blank" rel="noopener noreferrer">
        {View.bind(refcode)}
      </a>
    } @empty {
      <span class={props.class}>{View.bind(refcode)}</span>
    }
  };
```

This is still two levels deep, which is F3, and the `@for` misuse hides that each loop is a branch.

**`HitRow` ported (sketch):**

```tsx
const HitRow = (props: HitRowProps): Node => @{
  const state = Source.zip(props.row, props.expanded, (row, keys) => ({ hit: row.hit, key: row.key, expanded: keys.has(row.key) }));
  const before = Source.select(state, beforeSide);
  const after = Source.select(state, afterSide);
  const expandThis = View.event(() => Effect.flatMap(props.row.get, (row) => props.expand(row.key)));
  <li class="hit">
    <div class="meta">
      {Reference({ class: "refcode", refcode: Source.select(state, (s) => s.hit.refcode), url: Source.select(state, (s) => s.hit.url) })}
      <span class="book">{View.bind(state, (s) => s.hit.bookTitle)}</span>
      @if (View.when(state, (s) => s.hit.isHeading)) { <span class="kind">Chapter</span> }
      @if (View.when(state, (s) => s.hit.backMatter)) { <span class="kind">Back matter</span> }
    </div>
    <div class="body">
      @if (View.when(before, (s) => s.more > 0)) { <button type="button" class="expand" onClick={expandThis}>Show more</button> }
      @for (const paragraph of Source.select(before, (s) => keyed(s.shown)); key paragraph.key) { {Context({ paragraph })} }
      <div class={View.bind(state, matchClass)}><p class="text">{View.bind(state, (s) => s.hit.text)}</p></div>
      @for (const paragraph of Source.select(after, (s) => keyed(s.shown)); key paragraph.key) { {Context({ paragraph })} }
      @if (View.when(after, (s) => s.more > 0)) { <button type="button" class="expand" onClick={expandThis}>Show more</button> }
    </div>
  </li>
};
```

Against the current file (egw:`app.tsx:831-888`, 58 lines), the changes are:

- The `<Show when is>` lines become one-line `@if`s: about 10 fewer lines.
- `keyBy={(p: Paragraph) => p.key}` becomes `key p.key`. It reads shorter, but `paragraph` is a `Paragraph` in the key and a `Source<Paragraph>` in the body.
- `@{}` itself buys nothing: the current `HitRow` is already a plain function with locals before `return (…)`.
- Every `View.bind` stays, so F1 is untouched.

### Option (b): stay on JSX and take TSRX's ideas

Which ideas transfer:

| TSRX idea | Transfers? | As what |
| --------- | ---------- | ------- |
| Flat multi-branch (`@switch`, `@else if`) | **Yes** | A flat union `Match` over a derived source, for F3. ef's `Match` already accepts any `{ _tag }` union with an exhaustive case table, and each case gets a narrowed `Source` (ef:`control.ts:139-189`). `Reference` becomes one `Source.zip(refcode, url, …)` into `None \| Text{refcode} \| Link{refcode,url}`, drawn by one `<Match on cases>`, with no nesting and exhaustive at the type level. That is one level instead of `Show` in `Show`, with no new syntax. **Unverified**: not compiled. Separately, `Option` has a `_tag`, so `<Match on={Source.select(s, Option.fromNullishOr)} cases={{ None, Some }}>` may work today. |
| Locals beside markup (`@{}`) | **Already true** | A view's `Effect.gen` setup, or a plain function body before `return`, is that place. Document "name derived sources before the markup" (`before`/`after` above) as the pattern. |
| `@empty` on a loop | **Yes** | A `fallback` prop on `<For>`, matching `Show.fallback`. ef `ForProps` has none (ef:`control.ts:15-20`). |
| `key` clause on a loop | Partly | Already `keyBy`. The TSRX spelling hides the `Item` versus `Source<Item>` split, so do not copy it. |
| Guard `return` before output | No | Setup-once: a guard runs once, and a reader would expect it to react. Solid keeps plain `if` setup-once for the same reason (`tsrx-solid/src/transform.js:1461-1475`). |
| Directive-lowered control flow that can require a `Source` type | Already true | ef's tags already demand `Source`, and the named-error types teach the fix (ef:`intrinsics.ts:22-47`). |
| Scoped `<style>` | No | It cannot hold in the OpenTUI host, and hidden hash classes break "explicit". A CSS decision is separate from this loop. |
| Third-party compiler plugin into editor tooling | Later | Worth revisiting once TSRX runs on TS7 (#38). |

### Recommendation

**Option (b).** It keeps all five north stars and fixes F3 with API changes: a flat union `Match` pattern, possibly a `Match` helper for `Option` or nullable sources, and `For.fallback`. None of this needs a new language. Option (a) fails "explicit over implicit" at the gate:

- TS7 `tsc` does not see `.tsrx` (TS18003 probe).
- `tsrx-tsc` needs the classic JS `tsc`, which TS 7.0.2 does not ship (the 609-byte launcher).
- oxlint and oxfmt skip `.tsrx` (probes).

On top of that, `@if` cannot bind the narrowed source that `Reference` needs.

**The owner decides:**

1. Whether a template language is wanted at all, once TSRX runs on TS7 and oxc supports it. That is a bet on an outside beta project's roadmap (#38) and on keeping its churn in the loop.
2. Whether ef wants scoped CSS in views. TSRX's `<style>` is the only feature JSX cannot copy by API, and it does not work in the terminal host.
3. For option (b), whether the union-`Match` pattern ships as documentation only or with a helper, which would add a name to `CONTEXT.md`.

## Unverified, in one list

- That `function* () @{ … }` and `return @{ … }` inside `Effect.gen` parse and compile. The grammar and parser code support them, but the compiler was not run because `@sveltejs/acorn-typescript` is not installed locally.
- That Volar maps a diagnostic on a generated `<Show when=…>` back to the `@if` test.
- That the classic `@effect/language-service` composes with Volar's `runTsc`.
- That Bun accepts an inline source map and `loader: 'tsx'` from a `.tsrx` `onLoad`.
- That the history was imported from Ripple.
- That the union-`Match` rewrite of `Reference`, and `Match` over `Option`, type-check in ef.
