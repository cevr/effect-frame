---
"effect-frame": minor
---

Exports with no caller, or with a second path to a used name, are removed:

- `effect-frame/actor/client`: `isQueryFailure`, and the flat `FormContext`, `FormFields`, `FormIssue` and `FormIssues`. Write `Form.FormContext` and the other `Form.*` names.
- `effect-frame/actor`: the flat `batched` (write `Query.batched`), `queryServerOnly`, `MissingPolicy` (read it from `PolicyNamesMissing.missing`), and the types `QueryHostOptions` and `QueryServing`, whose producer is not public.
- `Behavior.wakeOf` and `Behavior.refusalOf` are internal. `Behavior` holds what an author writes: `value`, `reducer`, `machine` and the types.
