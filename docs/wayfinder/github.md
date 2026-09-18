# GitHub tracker

Repository: [Effect Frame](https://github.com/cevr/effect-frame).
Map: [First release: explicit actors across browser, terminal, and durable celld](https://github.com/cevr/effect-frame/issues/1).

## Wayfinding operations

The map is the issue with the `wayfinder:map` label.
Decision tickets are native GitHub sub-issues.
Blocking uses native issue dependencies.
The assignee is the claim. Assign a ticket to `cevr` before work.

Read the map:

```sh
gh issue view 1 --repo cevr/effect-frame
```

List its children:

```sh
gh api --paginate repos/cevr/effect-frame/issues/1/sub_issues
```

For each open, unassigned child, query its blockers:

```sh
gh api --paginate repos/cevr/effect-frame/issues/CHILD_NUMBER/dependencies/blocked_by
```

A ticket is in the frontier only when every blocker is closed.
Do not treat an assigned ticket as available.

Create all child tickets before adding dependency edges:

```sh
gh issue create --repo cevr/effect-frame --parent 1 --label wayfinder:research --title TITLE --body-file QUESTION_FILE
gh issue edit CHILD_NUMBER --repo cevr/effect-frame --add-blocked-by BLOCKER_NUMBER
gh issue edit CHILD_NUMBER --repo cevr/effect-frame --add-assignee cevr
```

Resolve a ticket with a comment. Then close it. Add one linked line to the map's Decisions so far section. Read the current map body before each update, so an edit does not discard another session's changes.

The map does not duplicate open ticket lists or decision details.
Use linked ticket titles in reports.
Do not resolve a human decision ticket without the owner's response.

Research uses a `research/<name>` branch in an isolated Rift.
Write findings under `docs/research/`.
Link the findings from the research ticket.
A local branch is not a published GitHub branch. State that limit when it applies.

The user approved execution after design. That does not close unresolved human decisions. Charting itself closes no human decision ticket.

## References

- [GitHub sub-issues](https://docs.github.com/en/rest/issues/sub-issues)
- [GitHub issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)
