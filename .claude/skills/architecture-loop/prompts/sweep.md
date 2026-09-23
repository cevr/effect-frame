# Sweep prompt

Fill the slots. One agent per area. Send all areas in one message.

```
Read-only architecture sweep, pass <N>, of `<rift or repo path>`. Write one report to `<scratchpad>/pass<N>-<area>.md` and reply once with a summary under 300 words. Finish in one run: no timers, monitors, or sub-agents. Read only: start no server and edit no file.

Scope: <directories>. <Extra weight: ...>

Read first: `CONTEXT.md`, `docs/design/acceptance.md`, `.claude/skills/architecture-loop/north-stars.md`, `<ledger path>`, `.claude/skills/architecture-loop/rejected.md`, and the earlier reports <paths>. A done or rejected item returns only with a new receipt. For prior-art questions, read `.claude/skills/architecture-loop/prior-art.md`; the repos are at `okra repo path <slug>`.

North stars: effect-native, actor-model, expressive, declarative, explicit over implicit. Each candidate names the north star it serves. A candidate that trades one north star for another is reported as an owner question, not as a change.

Vocabulary, used exactly: module, interface, depth, seam, adapter, leverage, locality, deletion test. A candidate is: a shallow module, a pass-through, one concept with two owners, a one-adapter seam with no guard, a single-caller export, dead code, a guard gap (a rule that `tooling/checks` or `.oxlintrc.json` cannot see), a comment that tells history, a Promise or callback where an Effect, Stream, or Scope belongs, state written outside an actor message, a hidden default or magic name, a per-mode or per-host branch in a view, or a public export with no test that uses it as a subject.

<Specific questions for this area, numbered>

Every claim carries a receipt: full path and line, plus the grep over `packages/`, `apps/`, AND `tooling/` that proves the caller count. Per candidate: files, problem, north star, change, lines removed, risk (low/med/high), public API change yes/no, wire or stored format change yes/no. A candidate that changes a wire or stored format is rejected by default. A public API change needs a changeset and says so. Under about 5 lines of pure style: one line in a "not worth a pass" list. An area with nothing to do reports "no findings" with the receipts checked; that is the wanted result of a late pass.
```
