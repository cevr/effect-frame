---
"effect-frame": minor
---

Send a command from a plain HTML form with no JavaScript (#21), and generate message values that no form field carries (#32).

New exports on `effect-frame/actor/client`:

- `Generated`: `fromCommandId(schema)`, `freshId(schema, width?)`, `send(ref, contract, input)`, `Input<M>`, `Generated<S>`, `Minted`, `Mintable`, `Generation`. A generated field is minted at render or at send, never at decode, and it cannot carry a decoding default.
- `Form`: `codec(schema)`, `Checkbox`, `Structure`, `Tree`, `Fields`, `FormContext`, `FormIssue`, `FormIssues`, `FormFields`, `FormMalformed`, `issuesOf`, `encodeKey`, `decodeKey`, `isReturnPath`, `frameworkFields`, and the field-map helpers `fromEntries`, `toEntries`, `fromBody`, `toBody`, `last`, `strip`, `submitted`, `withValues`, `without`, `tree`, `flatten`.
- `Form.IssuesJson`, `Form.encodeIssues`, `Form.decodeIssues`, `Form.issuesScriptId`, and `Form.provideIssues`: a refused page carries its `FormIssues` to the hydrating client, so the first client render matches the server.
- `Form.maxDepth` (32) and `Form.maxFields` (1000): the structural limits of a form body.
- `FormContext`, `FormFields`, `FormIssue`, `FormIssues` at the top level.
- `Wire.paths.form` (`/form`).

New exports on `effect-frame/actor`:

- `HttpServer.form({ contracts, render })`: the `POST {base}/form` handler. It answers 303 on success, 200 with the page on a validation failure, 504 with the same id on a lost reply, and 400 or 415 before any send.

New exports on `effect-frame/view`:

- `View.form(options)`: a command form binding. `name` sets the posted `$form` identity; the default is the member tag. The runtime draws `method`, `action`, and the hidden framework fields in every host. The DOM host cancels the native post and sends the same message; its first send adopts the rendered id.
- `View.CommandForm`, `View.FormBinding`, `View.PlainPost`.

Changes to existing types:

- `HostEvent` has a new `form: Option<FormFields>` field. A custom host sets it to `Option.none()` unless it reads a form.
- `Prepared` has a new `post: Option<PlainPost>` field. `View.event` and `View.submit` set it to `Option.none()`.
