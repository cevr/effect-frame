---
"effect-frame": minor
---

`View.form`'s `issues` is a `Source<ReadonlyArray<Form.FormIssue>>`, drawn with `<For each={add.issues} keyBy={(issue) => `${issue.field}:${issue.message}`}>`. A scripted submit that does not decode now shows the issues a plain post of the same input shows, where before it only logged a warning; a submit that decodes clears them. `View.form` now needs the view's `Scope`, which a view's setup has. A body that cannot nest, which a plain post answers 400, still sends nothing and logs.
