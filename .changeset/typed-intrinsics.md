---
"effect-frame": minor
---

JSX tags are a closed, typed map. `effect-frame/view` checks every HTML tag
against `HtmlElements`: a prop is the attribute as HTML spells it (`class`,
`for`, `tabindex`), a value is written once or bound with `View.bind`, and
an `on*` prop takes a prepared handler. An unknown tag, an unknown or
misspelled prop (`className`, `onClik`, `tabIndex`), and a child of a void
element do not compile. A raw `Source` where a value goes reports
`"wrap the source with View.bind(source)"`, and a plain function where a
handler goes reports `"wrap the handler with View.event(handler)"`.

`Prepared` carries a `kind` (`PreparedKind`, `"event" | "submit"`) in place
of `preventDefault`: `View.event` gives `Prepared<"event">`, and
`View.submit` and a `View.form` binding's `submit` give `Prepared<"submit">`,
whose default action the host suppresses. A form's `onSubmit` takes only
`Prepared<"submit">`, and a form takes no `method` or `action`: the runtime
writes a command form's plain post.

A terminal file names its runtime with `@jsxImportSource
effect-frame/view/opentui` (new subpaths `view/opentui/jsx-runtime` and
`view/opentui/jsx-dev-runtime`) and gets `box`, `text`, and `input`, whose
props are the OpenTUI renderables' own options.

The HTML host no longer renames `className` and `htmlFor`, and a leaf root
reads `tabindex` and `contenteditable` in their HTML spelling only. `Attr`,
`HtmlElements`, and `PreparedKind` are exported types.
