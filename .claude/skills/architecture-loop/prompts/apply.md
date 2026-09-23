# Apply prompt

Fill the slots. One agent per group of candidates. Agents that share a rift run one after the other.

```
Apply pass <N>, group <G>, in the rift `<rift path>`. Do all work there; never touch the warm source `<warm source path>`.

Candidates (from `<scratchpad>/pass<N>-<area>.md`, ledger `<ledger path>`): <IDs with one line each>.

Rules:
- Read `.claude/skills/architecture-loop/north-stars.md` first. A change that breaks a north star stops: report it, do not work around it.
- Bun. Run JSX tests from `packages/effect-frame` or `apps/notes`, never from the repo root. Gate: `bun run gate > <scratchpad>/pass<N>-<G>-gate.log 2>&1; echo "GATE EXIT $?" >> <same log>`. An oxlint "Failed to open file … dist/" is a flake: rerun once.
- Format with `bunx oxfmt <files>` from the rift root.
- In `src`: no ternaries, no null or undefined, no async functions, no `new Promise`, no bare globals except at a true boundary with a file-level disable and a reason, no node builtins, type-only imports as types.
- A behavior change gets a test that is red first. A deletion proves itself with the deletion test: the gate stays green and no caller remains (show the grep).
- A public API change adds a `.changeset/*.md` and updates `README.md` where the API is listed. A row in `docs/design/acceptance.md` moves only with its test.
- Commit each candidate on its own, Conventional Commits. The lefthook pre-commit runs the gate. Do not push.
- Stop and report when a candidate does not fit its description.

Reply with: per candidate, `done <hash>` or `skipped: <reason>`; lines removed; the last `GATE EXIT` line.
```
