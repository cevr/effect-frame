# Plain-form post conventions: SvelteKit, Remix 3, React server functions

Date: 2026-09-18.
Ticket: [Verify plain-form post conventions in SvelteKit, Remix 3, and React server functions](https://github.com/cevr/effect-frame/issues/14).
Method: primary source review. Official documentation pages and framework source code. No runtime tests.
Status: research complete. This document records facts and their consequences. It decides nothing.

## Result

The three frameworks agree on very little. Each one solves the same five problems a different way.

Only SvelteKit encodes types into the wire format. It puts a type prefix on the field name, so a plain form post coerces back to numbers and booleans before validation runs. Remix 3 offers coercion one layer up, in an optional schema package. React does nothing at all.

Each framework binds a form to its handler by a different mechanism. SvelteKit puts the identity in the URL query string. React puts it in the _name_ of a hidden input, and leaves the value empty. Remix 3 uses the route itself, and has no hidden identity field.

React's scheme is the closest match to the settled Effect Frame decision, which is a hidden command id in every form. See `docs/design/progressive.md`, row "Plain-form commands". React shows that an id in the field name needs no value, survives a submit-button override by last-write-wins, and separates from user fields by one prefix test.

No framework solves idempotent double posts. All three rely on redirect-after-post to stop a browser resubmission. Effect Frame already owns a stronger mechanism. See "Implications for Effect Frame".

## SvelteKit remote functions: `form`

The feature is experimental. The docs state: "This feature is currently experimental, meaning it is likely to contain bugs and is subject to change without notice." See K0. The source marks `form` as `@since 2.27`. See K1.

### Declaration and the spread

`form` accepts an optional Standard Schema and a handler. Three overloads exist: `form(fn)`, `form('unchecked', fn)`, and `form(schema, fn)`. See K1.

The spread `<form {...myForm}>` produces three things, and only three. See K1.

- `method`, fixed to `'POST'`.
- `action`, a getter that returns `` `?/remote=${__.id}` ``.
- A Svelte attachment that enhances the form when JavaScript runs.

The spread does not emit `enctype`. The author writes it. The docs say: "Because our form contains a `file` input, we've added an `enctype="multipart/form-data"` attribute." See K0.

### Field naming and coercion

This is the part no other framework has. The docs state: "The generated `name` attribute uses JS object notation (e.g. `nested.array[0].value`)" and "boolean checkbox and number field names are prefixed with `b:` and `n:`, respectively, to signal SvelteKit to coerce the values from strings prior to validation." See K0.

The source shows the full set is two prefixes and one array marker. See K2.

```js
function get_type_prefix(field_type, is_array, input_value) {
  if (field_type === "number" || field_type === "range") return "n:";
  if (field_type === "checkbox" && !is_array) return "b:";
  if (field_type === "hidden" || field_type === "submit") {
    const input_type = typeof input_value;
    if (input_type === "number") return "n:";
    if (input_type === "boolean") return "b:";
  }
  return "";
}
```

The prefix rules are these.

| Prefix | Applies to                                                              |
| ------ | ----------------------------------------------------------------------- |
| `n:`   | `number` and `range`. Also `hidden` or `submit` with a JS number value. |
| `b:`   | A non-array `checkbox`. Also `hidden` or `submit` with a boolean value. |
| none   | Everything else.                                                        |

A multi-value input adds a `[]` suffix to the name. This applies to `file multiple`, `select multiple`, and a `checkbox` with a string value. See K2.

The decoder reverses this. See K2.

```js
if (key.startsWith("n:")) {
  key = key.slice(2);
  values = values.map((v) => (v === "" ? undefined : parseFloat(v)));
} else if (key.startsWith("b:")) {
  key = key.slice(2);
  values = values.map((v) => v === "on");
}
```

Four consequences follow, and three are visible only in the source.

- The prefix sits at the front of the whole path, not on each segment. The name is `n:info.height`, not `info.n:height`.
- Boolean coercion is the literal test `v === 'on'`. An unchecked box sends nothing, so the key is absent. The source carries this error text: "All booleans in form schemas must be optional (e.g. `v.optional(v.boolean(), false)`) because checkbox inputs do not send a false value when unchecked." See K1.
- An empty number input becomes `undefined`. It does not become `NaN` or `0`.
- A `[]` suffix and an indexed path are two different mechanisms. Both decode to arrays.

The path grammar is a regular expression. See K2.

```js
const path_regex = /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*|\[\d+\])*$/;
```

This is why a key that needs quotes is unsupported. The decoder also blocks prototype pollution. It throws on `__proto__`, `constructor`, and `prototype`. See K2.

### Validation issues and re-render

The handler wrapper validates with `schema?.['~standard'].validate(data)`, which is Standard Schema v1. A handler may also raise `invalid(...)`. Both paths reach one function, `handle_issues`. See K1.

That function repopulates the form. See K1.

```js
function handle_issues(output, issues, form_data) {
  output.issues = issues.map((issue) => normalize_issue(issue, true));

  // if it was a progressively-enhanced submission, we don't need
  // to return the input — it's already there
  if (form_data) {
    output.input = {};
    for (let key of form_data.keys()) {
      // redact sensitive fields
      if (/^[.\]]?_/.test(key)) continue;
      const is_array = key.endsWith("[]");
      const values = form_data.getAll(key).filter((value) => typeof value === "string");
      if (is_array) key = key.slice(0, -2);
      set_nested_value(output.input, key, is_array ? values : values[0]);
    }
  }
}
```

Three facts matter here.

- `form_data` is non-null only for a full post. The repopulation path is the no-JavaScript path specifically.
- The regex `/^[.\]]?_/` drops any segment that starts with `_`. This is the documented leading-underscore redaction for passwords and card numbers. See K0.
- The filter `typeof value === 'string'` drops every `File`. A file input cannot be repopulated after a failed submission.

The docs confirm the user-facing effect: "`value()` is also populated if the submitted data is invalid, so that the user does not need to fill the entire form out from scratch." See K0.

`.as()` adds `aria-invalid="true"` when a field has issues. See K2.

### Redirect after post

The handler calls `redirect(303, url)`. The framework does not choose the status. The thrown value carries it, and the server re-emits it. See K3.

```js
if (err instanceof Redirect) {
  return { type: "redirect", status: err.status, location: err.location };
}
```

A handler that does not redirect returns `{ type: 'success', status: 200 }`, and the page re-renders in place. See K3.

### Binding a form to an id

SvelteKit puts the identity in the URL. The action is `?/remote=<id>`. The server reads it with `url.searchParams.get('/remote')`. See K1 and K3.

The id is a slash-delimited triple. See K3.

```js
// `hash` and `name` can never contain a `/`, but the JSON-stringified key of a
// keyed (`form.for(key)`) instance can — rejoin the remaining segments
const [hash, name, ...rest] = id.split("/");
const action_id = rest.join("/");
```

So the identity is `<module hash>/<export name>[/<encoded key>]`. Two forms on one page differ because their exports differ. Each gets a distinct action URL.

`myForm.for(key)` builds a keyed sibling. It appends a JSON-encoded key to the same id. See K1. The server then re-parses that key and injects it into the payload. See K3.

```js
if (action_id && !("id" in data)) {
  data.id = JSON.parse(decodeURIComponent(action_id));
}
```

A keyed handler therefore receives its key as `data.id` at no cost, unless the form data already carried an `id`. This behavior appears only in the source, not the docs.

`buttonProps` was removed. Multiple submit buttons now use an ordinary field. The development build throws with: "`form.buttonProps` has been removed: Instead of `<button {...form.buttonProps}>, use `<button {...form.fields.action.as(\"submit\", \"value\")}>`." See K1. `form.field(name)` was also removed. See K2.

An unmatched form export answers 405 with `allow: 'GET'`. See K3.

### Multipart

Multipart works. The author writes `enctype="multipart/form-data"`. `.as('file')` and `.as('file multiple')` generate the inputs. See K2.

The decoder filters an empty file input. The source comment reads: "an empty `<input type="file">` will submit a non-existent file, bizarrely". See K2.

An enhanced submission does not use multipart. It uses a custom binary framing under the content type `application/x-sveltekit-formdata`. See K2. The parser falls back to `request.formData()` when the content type differs. No size limit appears in the docs or in these source files.

## Remix 3

Remix 3 is a rewrite off React onto a Preact fork. See R0.

The chapters that would answer most of this question are unpublished. The guides index lists chapter 8 "Data and Validation", chapter 9 "Forms and Mutations", and chapter 11 "Files and Assets" with no URLs. See R1. All three return HTTP 404. Chapter 9 is described as covering "native forms, action responses, validation failures, redirects, and enhanced mutations". That is precisely this ticket's question, and it does not exist yet.

Treat this section as a snapshot of an unfinished framework.

### Handling a post

Routes come from `route()` and `form()`. `form()` is a shorthand for two routes at one URL. See R2.

```ts
let routes = route({
  home: "/",
  contact: form("contact"),
});
// contact: {
//   index: Route<'GET', '/contact'> - Shows the form
//   action: Route<'POST', '/contact'> - Handles the form submission
// }
```

The handler receives one context with `request`, `url`, `params`, `get`, and `set`. Form data is not parsed unless the route opts in with middleware. See R2 and R3.

```ts
action: {
  middleware: [formData()],
  handler(context) {
    let title = String(context.formData.get("title") ?? "");
    return new Response(`Updated ${title}`, { status: 200 });
  },
},
```

The guides note that "only the `POST` action parses `FormData`; the `index` page skips that work". See R2.

The form markup is written by hand, with an explicit `method="POST"` and an `action` from `routes.contact.action.href()`. No framework-generated action attribute exists, and no hidden identity field exists.

### Field naming and coercion

The router does neither. `get(FormData)` returns a raw web `FormData`. The framework's own example casts by hand with `formData.get('message') as string`. See R2.

An optional package adds coercion one layer up. `remix/data-schema` is "tiny, standards-aligned data validation… compatible with Standard Schema v1". Its `form-data` module supplies `f.field()`, `f.fields()`, `f.file()`, `f.files()`, and a `coerce` module that "turns stringly-typed inputs (like form data or query strings) into real types at the schema boundary". See R4.

Nesting is schema composition. The README states there is no special dot-notation for nested field names. Remix 3 therefore has coercion at the schema boundary and nothing at the name boundary. This is the opposite of SvelteKit.

### Redirect after post

`createRedirectResponse` defaults to **302**. See R5.

```ts
createRedirectResponse('/login')                 // 302
createRedirectResponse('/new-page', 301)
createRedirectResponse('/dashboard', { status: 303, headers: { ... } })
```

It accepts a relative location, which native `Response.redirect` does not.

The guides use the short name `redirect` and pass 303 explicitly for post-redirect-get. See R2.

```ts
import { redirect } from "remix/response/redirect";
return redirect(routes.albums.show.href({ albumId: context.params.albumId }), 303);
```

The router README example does not redirect. It returns HTML from the POST directly. Both shapes appear in primary sources. Only the guides name 303 as the pattern.

### Validation issues and re-render

One sentence exists: expected outcomes such as invalid input, conflicts, and missing records "should also return a `Response` with the appropriate status". Thrown errors are reserved for unexpected failures. See R2.

Nothing else is documented. No convention for echoing submitted values, no error shape, no field-level error API, and no `useActionData` analogue. Re-rendering a form with its errors and its values is hand-written today.

### Multipart

This is the most developed part of Remix 3. `parseFormData` streams. See R6.

```ts
parseFormData(request, uploadHandler);
parseFormData(request, { maxFiles, maxFileSize, maxParts, maxTotalSize });
```

It handles `multipart/*` and `application/x-www-form-urlencoded`. Anything else throws `FormDataParseError`. It "processes file upload streams with minimal memory footprint" and passes each `FileUpload` to the handler as it arrives. A returned value replaces the file in the resulting `FormData`. A returned nothing ignores the field.

Documented defaults are `maxFiles = 20`, `maxParts = 1000`, and `maxTotalSize` of `maxFiles * maxFileSize + 1 MiB`. Six named errors exist: `MaxFilesExceededError`, `MaxFileSizeExceededError`, `MaxHeaderSizeExceededError`, `MaxPartsExceededError`, `MaxTotalSizeExceededError`, and `FormDataParseError`. See R6.

The middleware wrapper always provides a `FormData`, empty for GET, HEAD, and non-form requests. Its `suppressErrors` option swallows malformed bodies, but never a multipart limit violation. See R7.

One hidden-field convention exists in the framework. `methodOverride()` reads `<input name="_method">` to override the request method, and must run after `formData()`. See R2 and R3. It concerns HTTP verbs, not command identity.

## React server functions, `useActionState`, and `permalink`

### The hidden fields

The docs state the behavior but never name the fields: "Passing a Server Function to `<form action>` allow users to submit forms without JavaScript enabled or before the code has loaded". See C0. The names live in the source.

`encodeFormAction` produces the metadata. See C3.

```js
if (boundPromise !== null) {
    ...
    const prefixedData = new FormData();
    encodedFormData.forEach((value, key) => {
      prefixedData.append('$ACTION_' + identifierPrefix + ':' + key, value);
    });
    data = prefixedData;
    // We encode the name of the prefix containing the data.
    name = '$ACTION_REF_' + identifierPrefix;
} else {
    // This is the simple case so we can just encode the ID.
    name = '$ACTION_ID_' + referenceClosure.id;
}
return {
    name: name,
    method: 'POST',
    encType: 'multipart/form-data',
    data: data,
};
```

Two shapes exist.

| Case             | Hidden fields                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Unbound function | One input named `$ACTION_ID_<referenceId>`. The **value is empty**.                           |
| Bound function   | One input named `$ACTION_REF_<prefix>`, plus one `$ACTION_<prefix>:<key>` per bound argument. |

The empty value is confirmed by the server renderer, which writes a name attribute and nothing else. See C5.

```js
if (formActionName !== null) {
  target.push(startHiddenInputChunk);
  pushStringAttribute(target, "name", formActionName);
  target.push(endOfStartTagSelfClosing);
  pushAdditionalFormFields(target, formData);
}
```

React overrides `action`, `encType`, `method`, and `target` on such a form, and warns in development: "Cannot specify a encType or method for a form that specifies a function as the action. React provides those automatically. They will get overridden." See C5.

The server decoder strips every `$ACTION_*` key before the function runs. See C4.

```js
body.forEach((value, key) => {
  if (!key.startsWith("$ACTION_")) {
    formData.append(key, value);
  } else if (key.startsWith("$ACTION_REF_")) {
    maybeActionKey = key;
  } else if (key.startsWith("$ACTION_ID_")) {
    maybeActionKey = key;
  }
});
```

The loop keeps the last matching key. The source explains why: "Later actions may override earlier actions if a button is used to override the default form action." This is how a submit button's `formAction` beats the form's own action.

Two forms on one page each carry their own hidden input. Identity is per form element, not per URL. The URL does not change.

### `permalink`

The signature is `useActionState(action, initialState, permalink?)`. The docs state: "If `reducerAction` is a Server Function and the form is submitted before the JavaScript bundle loads, the browser will navigate to the specified permalink URL rather than the current page's URL." The caveat: "ensure the same form component is rendered on the destination page (including the same `reducerAction` and `permalink`) so React knows how to pass the state through. Once the page becomes interactive, this parameter has no effect." See C1.

The source shows it does two things. See C6.

```js
dispatch.$$FORM_ACTION = (prefix) => {
  const metadata = boundAction.$$FORM_ACTION(prefix);
  // Override the action URL
  if (permalink !== undefined) {
    permalink += "";
    metadata.action = permalink;
  }
  const formData = metadata.data;
  if (formData) {
    if (nextPostbackStateKey === null) {
      nextPostbackStateKey = createPostbackActionStateKey(
        permalink,
        componentKeyPath,
        actionStateHookIndex,
      );
    }
    formData.append("$ACTION_KEY", nextPostbackStateKey);
  }
  return metadata;
};
```

It overwrites the form action URL, and it changes how the state key is computed. See C6.

```js
function createPostbackActionStateKey(permalink, componentKeyPath, hookIndex) {
  if (permalink !== undefined) {
    // Don't bother to hash a permalink-based key since it's already short.
    return "p" + permalink;
  } else {
    const keyPath = [componentKeyPath, null, hookIndex];
    const keyPathHash = createFastHash(JSON.stringify(keyPath));
    return "k" + keyPathHash;
  }
}
```

This is the reason `permalink` exists. Without it the key derives from the component's position in the tree. That position is stable only if the browser lands back on the same page rendering the same tree. A navigation to a different URL breaks a position-derived key. A permalink-derived key survives, because it does not depend on position.

A third hidden field carries that key. `$ACTION_KEY` is appended only when bound data exists, so it is always present for `useActionState`, which binds the state as the first argument. The source says: "We don't check for the simple `$ACTION_ID_` case because form state actions are always bound to the state argument." See C6.

The server returns `[actionResult, keyPath, referenceId, boundArity]`, and the renderer matches the key and the signature before it reuses the state. See C4 and C6. The signature check is weak on purpose. `isSignatureEqual` compares the reference id and the **number** of bound arguments, not their values. See C3.

### `bind()` and bound arguments

The docs state: "In lieu of using hidden form fields to provide data to the `<form>`'s action, you can call the `bind` method to supply it with extra arguments." See C0.

Without JavaScript the bound arguments serialize into the `$ACTION_<prefix>:<key>` inputs, and the form switches from `$ACTION_ID_` to `$ACTION_REF_`. So `bind()` and hidden inputs are one mechanism on the wire. The difference is encoding. Bound arguments are React-encoded and may carry non-string values. Hidden inputs are plain strings.

One consequence follows from the encoding. Bound arguments travel through the client and return from it. They are client-supplied input on the way back in.

### Field naming and coercion

React does nothing. The action "will be called with a single argument containing the form data of the submitted form", which is a raw `FormData`. See C0. There are no prefixes, no dotted paths, no array syntax, and no coercion. The only React-owned names are the `$ACTION_*` ones, and the decoder strips them first.

The docs add two behaviors. "After the `action` function succeeds, all uncontrolled field elements in the form are reset." And: "When a function is passed to `action` or `formAction` the HTTP method will be POST regardless of value of the `method` prop." See C0.

### Validation issues and re-render

The docs state three requirements. See C0.

> "Displaying a form submission error message before the JavaScript bundle loads for progressive enhancement requires that:
>
> 1. `<form>` be rendered by a Client Component
> 2. the function passed to the `<form>`'s `action` prop be a Server Function
> 3. the `useActionState` Hook be used to display the error message"

The mechanism is the `$ACTION_KEY` round trip. The server runs the action, the decoder returns the result with the key, and the renderer seeds `state` after it matches key and signature.

React preserves the **returned state**, not the submitted values. No automatic repopulation of field values exists in the no-JavaScript path. An author who wants the values back must return them in the state and render them as `defaultValue`. This is the asymmetry with SvelteKit.

With JavaScript, React "will also automatically replay form submissions entered before hydration finishes". See C2.

### Multipart

React always sets `encType: 'multipart/form-data'` on a server-function form. The value is hardcoded in the returned metadata. See C3 and C5. File inputs therefore work without any author action, and an author-supplied `enctype` is overridden.

The `FormData` may contain `File` values. The decoder callback signature is `(value: string | File, key: string)`. See C4. Neither React reference page documents file uploads. No limit is documented.

### Redirect

React has no `redirect`. It is framework-supplied, such as `redirect()` from `next/navigation`. The no-JavaScript submission is an ordinary POST to the page URL, or to the permalink, so a framework may answer 303 and get post-redirect-get. React defines neither the helper nor the status.

## Cross-cutting comparison

| Concern                 | SvelteKit                                                                                 | Remix 3                                                              | React                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Field naming, coercion  | `n:` and `b:` prefixes, `[]` suffix, dotted and indexed paths. Decoded before validation. | Raw `FormData`. Optional `coerce` in `data-schema`. No dot-notation. | Nothing. Raw `FormData`, flat string keys, hand-written casts.   |
| Redirect after post     | `redirect(303, url)` thrown. The author chooses the status.                               | `createRedirectResponse`, default **302**. Guides pass 303.          | None. Framework-specific.                                        |
| Validation re-render    | Issues plus automatic value repopulation, minus `_` fields and minus files.               | Not documented. Hand-rolled `Response`.                              | Returned state only. No value repopulation.                      |
| Binding to a command id | In the URL: `?/remote=<hash>/<name>[/<key>]`.                                             | In the route. No identity field.                                     | In a hidden input's **name**: `$ACTION_ID_*` or `$ACTION_REF_*`. |
| Multipart               | Author writes `enctype`. No documented limits.                                            | Streaming parser, documented limits, six named errors.               | `enctype` always set and overridden. Undocumented.               |

Three points deserve emphasis.

First, ranked by how much the framework knows about the author's shape: SvelteKit, then Remix 3 by opt-in, then React with nothing.

Second, React's identity scheme is the most instructive for a hidden command id. Putting the id in the field name rather than the value means it needs no value, it survives a submit-button override by last-write-wins, and one prefix test separates it from every user field.

Third, no framework gives an idempotent double post. All three rely on redirect-after-post so that a browser reload does not resubmit. That is a convention, not a guarantee. A user who presses back and re-submits still sends the command twice.

## Implications for Effect Frame

These are consequences, not decisions. Every decision belongs to a later ticket.

### The settled decision already goes further than any of the three

`docs/design/progressive.md` records: "The server renders a hidden command id into every form. A double post hits the receipt." The actor core already implements the receipt half. See E3.

```js
if (entry.command.payloadHash !== input.payloadHash) {
  return [CommandConflict.make({ commandId: input.commandId }), log];
}
return [{ _tag: "Duplicate", admitted: entry.command.admitted, receipt: entry.receipt }, log];
```

A second post with the same command id and the same payload returns `Duplicate` with the stored receipt. The actor does not apply the message twice. A second post with the same id and a different payload returns `CommandConflict`. This is a true idempotency guarantee. None of the three frameworks has one. Effect Frame therefore does not need redirect-after-post to protect correctness, only to protect the browser's reload prompt.

### The wire cannot accept a form post today

`packages/actor/src/http/wire.ts` defines `SendBody` as `{ address: { contract, version, key }, commandId, payload }`, where `payload` is a JSON string. The server decodes each route with `Schema.fromJsonString`. See E0 and E1. A plain form posts `application/x-www-form-urlencoded` or `multipart/form-data`. It cannot produce that body.

So a plain-form path needs a translation step between the form encoding and the actor wire. That step must reconstruct four things from flat string fields: the contract name, the version, the key, and the tagged message. The key is itself a struct. In the notes example it is `{ tenant, list }`. See E4. Nested reconstruction is therefore required, not optional. This is exactly the problem SvelteKit's dotted paths solve and React ignores.

### The SSR host drops handlers entirely

`packages/view/src/hosts/html.ts` states at its listener hook: "The server never receives an event. The listener is a no-op and so is its cleanup." See E5. The server renderer emits no `action` and no `method`.

Separately, `view.submit` is documented in `packages/view/src/view.ts` as "`event`, but the host suppresses its default action first", and it always sets `preventDefault: true`. See E6.

The consequence is concrete. The form in `apps/notes/src/page.tsx` is JavaScript-only by construction. See E7. Without JavaScript it has no action to post to. With JavaScript the native post is always cancelled. A plain-form mode needs the HTML host to emit real `action` and `method` attributes, and needs a submit binding that does not unconditionally cancel the default.

### Command id generation must move to the server

`apps/notes/src/commands.ts` carries this comment: "The client owns the command id. One user action makes one id, so a retry of the same action is idempotent and the mailbox applies it once." See E8. It draws the id from `Random.next` inside Effect.

In a plain-form post there is no client to draw it. The settled decision says the server renders the id into the form. So the render, not the event handler, must mint the id. One rendered form carries one id. That preserves the idempotency property across the change: a reload resubmits the same id, and the mailbox returns the stored receipt.

This also introduces a question the three frameworks do not answer, because none of them mints ids. A re-rendered form after a validation failure must decide whether to keep the same id or mint a fresh one. Keeping it means a corrected resubmission with different values hits `CommandConflict`, because the payload hash changed. See E3. That is a real consequence of the existing guard, and a later ticket must settle it.

### Two identity schemes are available, and they are not equivalent

SvelteKit's URL scheme and React's hidden-name scheme both work. They differ in one way that matters here.

The actor address is `{ contract, version, key }`, and the key is arbitrary data. See E0. SvelteKit encodes its key by JSON-stringifying it into the action URL. That places arbitrary data in a query string, with its length limits and its logging exposure. React's hidden-name scheme has no such limit, because a hidden input's name and value are body content.

React's scheme also composes with the command id naturally. A prefix test separates framework fields from author fields in one pass, with no allowlist. The decoder in `ReactFlightActionServer.js` is nine lines. See C4.

### The `n:` and `b:` problem is ours too

Effect Frame messages are `Schema.TaggedStruct` unions. See E4. A `Toggle` carries a string id. An `Add` carries two strings. Those coerce trivially. A message with a number or a boolean does not.

SvelteKit's checkbox rule is the sharp case, and its own source records the trap: an unchecked box sends no field at all, so every boolean in the schema must be optional with a default. Effect Frame uses `Schema.Boolean` in its snapshot today, in `Note.done`. See E4. Any future boolean in a _message_ inherits this problem the moment a form posts it.

Effect Schema already decodes from strings. The open question is where coercion is declared: in the field name as SvelteKit does, or in the schema as Remix 3's `coerce` does. The first survives a raw `FormData` with no schema present. The second keeps the markup clean. Both are viable. A later ticket chooses.

### Multipart is out of scope for now, and the map already says so

Map #11 lists under "Not yet specified": "File uploads through commands (multipart bodies, size limits, storage handle in the snapshot)." Remix 3's parser is the strongest prior art found, with a streaming handler, documented defaults, and six named limit errors. See R6. SvelteKit's file behavior carries one lesson worth recording early: a failed validation cannot repopulate a file input, because files do not survive the round trip. See K1.

## Primary source inventory

Documentation URLs are live pages read on 2026-09-18. Source links point at `main` in each repository. `main` moves, so pin a tag before relying on an exact spelling.

### SvelteKit

- **K0 — Documentation.** [Remote functions](https://svelte.dev/docs/kit/remote-functions). Experimental notice, `b:`/`n:` prefixes, JS object notation, `enctype`, leading-underscore redaction, `value()` repopulation, `invalid()`, single-flight mutations, prerender and command caveats.
- **K1 — `form` implementation.** [`packages/kit/src/runtime/app/server/remote/form.js`](https://github.com/sveltejs/kit/blob/main/packages/kit/src/runtime/app/server/remote/form.js). Overloads, `method`/`action` getter, `handle_issues`, `.for(key)`, `.set()` during submission, removed `buttonProps`, the optional-boolean error text.
- **K2 — Form data utilities.** [`packages/kit/src/runtime/form-utils.js`](https://github.com/sveltejs/kit/blob/main/packages/kit/src/runtime/form-utils.js). `get_type_prefix`, `convert_formdata`, `split_path` and `path_regex`, prototype-pollution guard, the field proxy, `aria-invalid`, the empty-file filter, `application/x-sveltekit-formdata`.
- **K3 — Server remote handling.** [`packages/kit/src/runtime/server/remote.js`](https://github.com/sveltejs/kit/blob/main/packages/kit/src/runtime/server/remote.js). `get_remote_action`, the `hash/name/key` split, the `data.id` injection, the redirect pass-through, the 405 answer.
- **K4 — `buttonProps` removal.** [sveltejs/kit#14622](https://github.com/sveltejs/kit/pull/14622).

### Remix 3

- **R0 — Announcement.** [Wake up, Remix!](https://remix.run/blog/wake-up-remix).
- **R1 — Guides index.** [guides.remix.run](https://guides.remix.run/). Chapters 8, 9, and 11 are listed with no URLs. All three return 404.
- **R2 — Router README and routing guide.** [`packages/fetch-router/README.md`](https://github.com/remix-run/remix/blob/main/packages/fetch-router/README.md), [Routing and controllers](https://guides.remix.run/routing-and-controllers/). `form()` shorthand, handler context, `formData()` middleware, the hand-written action attribute, the 405 answer, `methodOverride`, the 303 redirect example, the expected-outcome sentence.
- **R3 — Request handling guide.** [Request handling](https://guides.remix.run/request-handling/). Middleware import path, `methodOverride` ordering.
- **R4 — Data schema.** [`packages/data-schema/README.md`](https://github.com/remix-run/remix/blob/main/packages/data-schema/README.md). Standard Schema v1, `f.field`, `f.fields`, `f.file`, `f.files`, the `coerce` module, no dot-notation.
- **R5 — Response helpers.** [`packages/response/README.md`](https://github.com/remix-run/remix/blob/main/packages/response/README.md). `createRedirectResponse` overloads, the 302 default, relative locations.
- **R6 — Form data parser.** [`packages/form-data-parser`](https://github.com/remix-run/remix/tree/main/packages/form-data-parser). `parseFormData`, the upload handler contract, `maxFiles`, `maxParts`, `maxTotalSize`, the six error classes.
- **R7 — Form data middleware.** [`packages/form-data-middleware`](https://github.com/remix-run/remix/tree/main/packages/form-data-middleware), [0.3.0 release note](https://newreleases.io/project/github/remix-run/remix/release/form-data-middleware@0.3.0). The always-provide-`FormData` change, `suppressErrors`.

### React

- **C0 — `<form>` reference.** [react.dev/reference/react-dom/components/form](https://react.dev/reference/react-dom/components/form). No-JavaScript submission, `bind`, raw `FormData`, uncontrolled reset, forced POST, the three progressive-enhancement requirements.
- **C1 — `useActionState`.** [react.dev/reference/react/useActionState](https://react.dev/reference/react/useActionState). The `permalink` parameter and its caveats.
- **C2 — Server functions.** [react.dev/reference/rsc/server-functions](https://react.dev/reference/rsc/server-functions). Pre-hydration replay.
- **C3 — Reply client.** [`packages/react-client/src/ReactFlightReplyClient.js`](https://github.com/facebook/react/blob/main/packages/react-client/src/ReactFlightReplyClient.js). `encodeFormAction`, `$ACTION_ID_`, `$ACTION_REF_`, `$ACTION_<prefix>:<key>`, the hardcoded `encType`, `isSignatureEqual`.
- **C4 — Action server.** [`packages/react-server/src/ReactFlightActionServer.js`](https://github.com/facebook/react/blob/main/packages/react-server/src/ReactFlightActionServer.js). The `$ACTION_*` strip, the last-key-wins comment, `$ACTION_KEY` decoding, the `string | File` callback signature.
- **C5 — Fizz DOM config.** [`packages/react-dom-bindings/src/server/ReactFizzConfigDOM.js`](https://github.com/facebook/react/blob/main/packages/react-dom-bindings/src/server/ReactFizzConfigDOM.js). The hidden input with a name and no value, the attribute override and its development warning.
- **C6 — Fizz hooks.** [`packages/react-server/src/ReactFizzHooks.js`](https://github.com/facebook/react/blob/main/packages/react-server/src/ReactFizzHooks.js). The `permalink` action override, `createPostbackActionStateKey`, the `$ACTION_KEY` append, the state match on re-render.

### Effect Frame

Paths are relative to the repository root.

- **E0 — Actor wire shape.** `packages/actor/src/http/wire.ts:24` through `:41`. `WireAddress`, `SendBody`, `CallBody`, the JSON `payload` string.
- **E1 — Server decoding.** `packages/actor/src/http/server.ts:25` through `:36`, and `:104` through `:142`. `Schema.fromJsonString` on every route, POST-only, no form-encoded branch.
- **E2 — Command vocabulary.** `packages/actor/src/vocabulary.ts:9`, `:16`, `:40` through `:46`. `CommandId`, `CommandConflict`, `DurableReceipt.committed` as an `Option`.
- **E3 — Mailbox idempotency.** `packages/actor/src/mailbox-store.ts:85` through `:108`. The payload-hash comparison, the `Duplicate` outcome, the `CommandConflict` outcome.
- **E4 — Notes contract.** `apps/notes/src/contract.ts`. `NotesKey` as a struct, the tagged message union, `Note.done` as a boolean.
- **E5 — HTML host.** `packages/view/src/hosts/html.ts:168`. "The server never receives an event. The listener is a no-op and so is its cleanup."
- **E6 — View capabilities.** `packages/view/src/view.ts:48` through `:50`, and `:80` through `:96`. `submit` as `event` with `preventDefault` always set.
- **E7 — Notes page.** `apps/notes/src/page.tsx`. The `onSubmit` form with no `action` and no `method`.
- **E8 — Notes commands.** `apps/notes/src/commands.ts`. Client-owned command ids drawn from `Random.next`.
- **E9 — Settled decisions.** `docs/design/progressive.md:16` and `:28`. Plain-form posts in scope, and the hidden command id decision.
