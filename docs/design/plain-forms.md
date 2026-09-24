# Plain forms and generated fields

This note records how #21 (plain-form command submission without
JavaScript) and #32 (message values that no form field carries) are built.
It lists the decisions that the tickets left to the build and the places
where the build differs from the ticket text. The tickets stay the source
of the design.

Sources:

- `packages/effect-frame/src/actor/generated.ts` — `Generated`.
- `packages/effect-frame/src/actor/form.ts` — `Form` (browser safe).
- `packages/effect-frame/src/actor/http/form-post.ts` — `HttpServer.form` (server only).
- `packages/effect-frame/src/view/form.ts` — `View.form` and repopulation.

Proofs: the #21 and #32 rows in [the acceptance matrix](acceptance.md).

## The rule

Every value in a posted message is a pure function of the fields the user
typed and the command identity the render minted. Decoding generates
nothing (#32).

## Generated fields

A generated field is an annotation on its own schema. It is not a wrapper,
so `Schema.Schema.Type` of the message does not change and the field stays
required.

```ts
const Add = Schema.TaggedStruct("Add", {
  id: Generated.fromCommandId(Schema.String), // equal to the command id
  text: Schema.String,
});
const Tag = Schema.TaggedStruct("Tag", {
  id: Generated.freshId(Schema.String, 8), // 8 base-36 characters from `Random`
  label: Schema.String,
});
```

1. The type brand `Generated<S>` adds `Minted` to the encoded side. No
   literal satisfies `Minted`, so `Schema.withDecodingDefault`
   over a generated field does not compile. A field that already has a
   default is optional when encoded, so `Generated` refuses it too.
2. `Generated` takes a required string codec only. A number does not
   compile.
3. `Generated.Input<M>` is the message without its generated keys.
   `Generated.send(ref, contract, input)` mints the command id, fills each
   generated field, decodes the message, and sends it under that id. The
   author never writes a generated value. `ref.send` does not change, so
   the command lifecycle files stay as they are (#19).
4. The render mints. `View.form` mints the command id and each generated
   value in setup and writes them as hidden inputs. The form codec only
   decodes: a body without a generated field fails with an issue at that
   field.

## The form codec

`Form.codec(schema)` is `Form.Structure` followed by the message schema.
`Form.Structure` reads a flat field map into a tree. The message schema
does all coercion, so a field name never carries a type.

- Grammar: `name := segment ("." segment | "[" digits "]")* "[]"?`.
- The names `__proto__`, `constructor`, and `prototype` are refused. A leaf
  and a branch at one path are refused. A list filled by both `[n]` and
  `[]` is refused, because an appended value has no index to agree with a
  written one. A name deeper than `Form.maxDepth` (32) segments and a body
  with more than `Form.maxFields` (1000) fields are refused. Each refusal
  is `FormMalformed`, and it happens before the message schema runs.
- An empty value is dropped, unless the name ends in `[]`.
- `Form.Checkbox` is an optional encoded string that decodes to a boolean.
  Absent is `false`. Present is `true`. It encodes `true` as `"on"`, on the
  JSON wire too.
- A message that has no form encoding does not build: a non-string encoded
  field, or a boolean without an optional encoded side.
- `View.form` takes `typed`, the fields that the form's own inputs carry.
  A member field that no input types, no mark generates, and no default
  fills does not compile.

## Framework fields

Names that start with `$` belong to the framework. The last value wins.
`Form.strip` removes all of them before the message decodes.

| Field        | Value                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| `$command`   | The command id the render minted.                                      |
| `$contract`  | The contract name.                                                     |
| `$version`   | The contract version.                                                  |
| `$key`       | The actor key, form-urlencoded (`Form.encodeKey`).                     |
| `$return`    | A root-relative path for the 303.                                      |
| `$form`      | The form's identity on the page. Default: the member tag.              |
| `$uncertain` | Only on a form redrawn after a lost reply. Its id may be in a mailbox. |

A name with a segment that starts with `_` is redacted. It decodes, but a
refused post never writes it back into the page.

## The route

`HttpServer.form({ contracts, principal, login, render })` answers `POST {base}/form`
(`Wire.paths.form`). The checks run in this order, and each refusal happens
before a send.

The media type is compared without case. A `charset` parameter other than
UTF-8 is a 415: the body is read as UTF-8, so a body in another charset is
refused, not decoded wrongly.

`$return` must be printable ASCII (no C0 control character, no space, no
DEL, nothing above `~`). It must start with one `/` that is not followed by
`/` or `\`. It must then resolve against a sentinel base to that same
origin. A URL parser drops tab, LF, and CR before it reads, so `/<tab>/host`
is `//host` to a browser. The printable check refuses it first. A value that
passes is also a valid `Location` header, so the 303 cannot fail after the
send. An encoded slash (`/%2f%2fhost`) is a path on this origin, and it is
accepted.

| Case                                                        | Answer                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A multipart body, or a type that is not urlencoded          | 415, plain text                                                                             |
| `$return` is absent or leaves the origin                    | 400, plain text                                                                             |
| `$command`, `$version`, `$key`, or `$form` is bad or absent | 400, plain text                                                                             |
| `$contract` names no served contract                        | 404, plain text                                                                             |
| `$version` is not the contract's version                    | 409, plain text                                                                             |
| A structural failure (`FormMalformed`)                      | 400, plain text                                                                             |
| The message does not decode                                 | 200, the page with issues and a fresh id, or the same id when the post carries `$uncertain` |
| The fields decode to two different payloads                 | 500, plain text, logged, nothing sent                                                       |
| The command commits, or it is a `Duplicate`                 | 303 to `$return`, after the commit is readable                                              |
| No commit within `commitWithin` (`Uncertain`)               | 504, the page with the same id and values                                                   |
| `Unreachable` (the outcome is `Uncertain`)                  | 504, the page with the same id and values                                                   |
| `CommandConflict`, `ContractMismatch`                       | 409, the page with a fresh id                                                               |
| `UnknownContract`                                           | 404, the page with a fresh id                                                               |
| `Unauthorized`, principal `Anonymous`, `login` is set       | 303 to `login?next=<$return>`                                                               |
| `Unauthorized`, any other case                              | 403, the page with a fresh id                                                               |
| `ActorStopped`                                              | 503, the page with a fresh id                                                               |

`render(path)` draws the page for the posted `$return`. The route provides
`FormContext` to it. A render failure is a 500, and it is logged.

The 303 follows the commit, not the admission. The route calls the host
with a wait of `commitWithin` (ten seconds when the app names none), and
the host answers once a read sees the commit. So a `$return` page that is
rendered on request draws the committed state (#21 §5). A prerendered
`$return` page, such as a Blog post, is a file: it shows the commit only
after the page hydrates. The route also bounds the whole call by
`commitWithin`, because a remote host starts its own wait only once it is
reached. A post that admits and does not commit in time may still apply, so
it answers 504 with the same id. `tests/actor/plain-commit.test.tsx` holds
the store's commit on a latch, and replaces the transport with one that never
answers, and proves each case.

The page must carry its `FormIssues` to the client, the way it carries a
snapshot. Otherwise the hydrating client draws the form without the issues,
and hydration finds mismatches. The server embeds
`Html.jsonScript(Form.issuesScriptId, yield* Form.encodeIssues(issues))`
when `FormContext` is present. The client reads that script with
`Form.decodeIssues` and mounts through `Form.provideIssues(issues)`. The
notes app does both, in `apps/notes/src/server.ts` and
`apps/notes/src/client.tsx`.

## The binding

```tsx
const Compose = (props: { readonly notes: NotesRef }) =>
  Effect.gen(function* () {
    const add = yield* View.form({
      ref: props.notes,
      contract: Notes,
      key: demoKey,
      message: Add,
      typed: ["text"],
      endpoint: "/actors",
      returnTo: "/",
    });
    return (
      <form onSubmit={add.submit}>
        <input name="text" />
      </form>
    );
  });
```

1. The runtime draws the plain post in every host: `method="post"`, the
   `action`, and the hidden inputs before the form's own children. The
   order is `$command`, `$contract`, `$version`, `$key`, `$return`,
   `$form`, `_tag`, then the generated fields.
2. With `FormContext` for this contract, key, and `$form`, the binding
   takes the server's id. Another form on the same key keeps its own id,
   its own generated values, and none of the issues. It keeps a fresh generated value only when the id was kept.
   The static `input`, `textarea`, and `select` children get the submitted
   values back, and each field with an issue gets `aria-invalid="true"`.
3. The DOM host cancels the native post and reads `FormData` at submit
   time, with the submitter's name and value. The first send adopts the
   `$command` and generated values that the markup carries. After
   hydration those are the server's. Each later send mints a fresh id and
   fresh values in one step.

## Decisions and deviations

- The runtime, not the HTML host, draws the hidden inputs. The hydrating
  host must claim the server's nodes in order, so every host draws them.
  The hydrating host keeps the server's values.
- `View.form` is for hosts that have a form element: the HTML and DOM
  hosts. A terminal view has no form to post, so it sends with
  `Generated.send`. The notes terminal does this.
- `View.submit(handler)` stays for a form that posts no command. A command
  form uses `View.form`. It is an Effect that runs in setup, because
  minting is effectful.
- `View.form` takes `ref`, `contract`, and `key` together. A ref does not
  expose its contract or key, and `ref.ts` stays unchanged for the #19
  merge.
- The scripted path uses `Generated.send` semantics. The type of `ref.send`
  does not change.
- The route derives the principal from the request with the same
  `principal` derivation as the JSON handler, and runs the send under
  `CurrentPrincipal`. The same policy authorizes a plain post and a
  scripted send. There is no second authorization path (#20 §5).
- An anonymous post that is `Unauthorized` gets a 303 to `login`, with
  `next` set to `$return`, when `login` is `Option.some(path)`. Signing in
  can change the answer. The posted body is not kept.
- An authenticated post that is `Unauthorized` gets 403 with the page.
  Signing in again changes nothing, so a login redirect would be wrong.
  With `login: Option.none()`, every refusal is a 403.
- A 400 answer is plain text, not a rendered page. The request is not a
  form this server rendered.
- `FormIssues` carries `contract`, `key`, and `form`, so that each binding
  on a page finds only its own refusal. `form` is the posted `$form`. It
  defaults to the member tag. Two forms for one member on one key must set
  `name` to be told apart.
- A bound value (`value={View.bind(...)}`) on a refused control is drawn
  from the post, not from the binding, on both sides of hydration. The
  control keeps the posted value for the life of that mount.
- Repopulation skips controls inside `For`, `Show`, and `Match`. Their own
  setup draws them.
- If the script dies after a scripted send, a native post of the same
  rendered id can answer 409 (`CommandConflict`) when the fields differ.
  With the same fields it is a `Duplicate`.
- `Unreachable` is treated as `Uncertain`: 504, same id, same values, and
  `$uncertain` in the form. `FormIssues.outcome` is `Uncertain` for this
  page and `Refused` for every other redraw. The hydrating host draws the
  same marker from the same `FormIssues`, so hydration finds no mismatch.
- A post that carries `$uncertain` and does not decode keeps its id and
  the marker. Its id may be in a mailbox. A fresh id would let the
  corrected post apply the message a second time under a new id, which
  breaks the actor-model north star. Every other post that does not
  decode gets a fresh id, as #21 §4 decided. The marker only chooses which
  id the redraw carries. A forged marker keeps the poster's own id, which
  the poster already controls, so it grants nothing.
- The scripted binding spends an id when it sends, not when the form fails
  to decode. So on a hydrated 504 page, a submit that does not decode sends
  nothing, and the corrected submit still carries the adopted id.
- The binding chooses the id, decodes, and spends the id under one
  `Semaphore(1)` per form. The DOM host forks each submit, and a decode can
  wait, so without it two valid submits could both take the rendered id,
  and the second would post other bytes under it and meet
  `CommandConflict`. With it, the second waits, finds the id spent, and
  mints its own. The send runs after the permit is released. We chose the
  semaphore over a `Ref` state machine (`Unspent` → `Deciding` → `Spent`):
  it is one line, and the state machine would need a waiting rule for the
  `Deciding` state, which the semaphore already is.
- A scripted resend mints a fresh id. The first scripted send adopts the
  rendered id. Each later send from the same form, including a retry after
  a refusal on the client, mints a new id and new generated values. Only a
  plain post re-sent by the browser reuses an id.
- There is no CSRF protection, and no claim of it. The route accepts any
  urlencoded post that names a served contract. #20 added authorization but
  decided nothing about CSRF, so no origin check is built. With a
  cookie-derived principal, set the cookie `SameSite=Lax` or stricter. See
  [authorization](authorization.md#gaps).
- A hydrating client runs the same setup, so `View.form` draws an id there
  too. The hydrating host keeps the server's hidden inputs and does not
  write the client's values, and the first send reads the markup. So the
  client never sends an id it minted over a rendered one. On an ordinary
  page, the binding's `commandId` on the client is the id it drew, not the
  markup's. On a refused page mounted through `Form.provideIssues`, it is
  the markup's.

## One settlement mechanism

A plain post and a scripted send settle a lost reply the same way (#29
§5, #21 §5). These facts make it hold:

1. The form route calls `transport.call` with the posted `$command` and the
   JSON payload of the decoded message. `/send` and `/call` reach the same
   host mailbox. The host admits a command id once. A later send of that id with
   the same payload text is `Duplicate`, and it carries the stored
   receipt. A different payload text is `CommandConflict`, even when the
   two payload hashes are equal. The stores use the hash only as a fast
   refusal and then compare the stored text. `Hash.string` gives
   `{"title":"00008t"}` and `{"title":"0000fj"}` one hash, so a store that
   trusted the hash would answer `Duplicate` to a different message.
2. The route and the hydrated binding decode the same fields with the same
   schemas, and they encode with `contract.message`. So one rendered form
   gives one payload on both paths, **if the message codec is
   repeatable**.
3. An `Uncertain` outcome keeps the id on both paths. The route draws the
   504 page with the same `$command` and with `$uncertain`. The binding's
   first send adopts that id. The command owner retries a lost pass with
   the same id and the same bytes.

The changes stream settles nothing (#29 §1).

### Preconditions

- **A form message codec must be repeatable.** The same fields must decode
  and encode to the same payload every time. A value that needs entropy or
  a clock is minted at render as a generated field (#32), never at decode.
  A decoding default that draws a new value on each decode breaks this.
  The route enforces it: it decodes and encodes the posted fields a second
  time, and when the two payloads differ it answers 500, logs the contract
  name, and sends nothing. We chose this over a development-only check or a
  conformance helper for apps, for three reasons. The package has no
  development mode flag to hang a check on. A helper runs only when an app
  remembers to call it. The cost is one more decode and encode of a small
  body per plain post, which is trivial next to the durable append that
  follows. The check is best effort: a codec that draws the same value
  twice by chance passes it. It catches a counter, a clock read with
  changing output, and random draws.
- **A redacted field is typed again after a 504.** A field whose segment
  starts with `_` is never written back into a page. If the message
  requires it, the redrawn 504 form posted as it is does not decode. The
  route answers 200 with an issue at that field. It keeps the same id and
  `$uncertain`, and it sends nothing. When the user types the same value
  again, the post reaches the stored receipt (303). When the user types a
  different value, the store answers `CommandConflict` (409, a fresh id).
  In no case is a second command admitted under that id with other bytes,
  and the message is not applied twice.

Decision: the proof is in the package, over one real socket. The browser
with no script is `fetch`. The browser with its bundle is a happy-dom
page that hydrates and sends through `HttpTransport`
(`packages/effect-frame/tests/view/plain-retry.test.tsx`). The proof
covers both orders: a plain post first, and a scripted send first. The
preconditions are proven in `packages/effect-frame/tests/actor/plain-form.test.tsx`,
`packages/effect-frame/tests/view/plain-form.test.tsx`, and the store
conformance suite. A browser that runs its own script is not needed for
this row. The race-with-hydration row in `apps/notes/tests/e2e.test.tsx`
stays the app proof.

## Not built

- File uploads. A multipart body is refused (#21 §6).
- Streaming SSR (#22). The page renders to a string.
- The example apps of #25 (wizard, blog, jobs). Their rows stay Open.
