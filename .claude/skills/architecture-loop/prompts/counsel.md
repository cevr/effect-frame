# Counsel prompt

One round per pass. Use the `counsel-review` skill, or a fresh read-only agent when the other model is not reachable. Give it this prompt.

```
Read-only review of pass <N> in the rift `<rift path>`: `git log --oneline <base>..HEAD` and `git diff <base>..HEAD`. Edit no tracked file; put any scratch test under `packages/effect-frame/tests/zz-scratch-*` and remove it with `trash`, so `git status` is clean when you finish.

Judge each commit against `.claude/skills/architecture-loop/north-stars.md` and the ledger `<ledger path>`. Look for real defects only:
- behavior that changed where the ledger row says "no behavior change";
- a scope, fiber, or subscription that no longer closes;
- a message that can now apply twice, apply out of admission order, or be lost;
- a browser entry that can now reach server code (`bun run boundary` must stay clean);
- a type that got wider, so a wrong program now compiles;
- a test that passes for the wrong reason;
- a north star that a commit quietly broke.

Per finding: file:line, a concrete failure (input or event order → wrong output), severity, reproduced yes/no. No style nits. If nothing is real, say so and list what you checked.
```

Fix each defect with a test that is red first, in one fix commit. A defect you do not fix gets a written rejection in the ledger.
