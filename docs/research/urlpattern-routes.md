# URLPattern as the template for bidirectional schema routes

Date: 2026-09-18.
Ticket: [Verify URLPattern as the template for bidirectional schema routes](https://github.com/cevr/effect-frame/issues/13).
Method: WHATWG specification review, MDN and web-features compatibility data, the Chrome `generate()` explainer, Foldkit's routing documentation, and empirical runtime tests in Bun 1.4.2 and Node 24.11.1.

## Result

URLPattern parses. It does not print. The shipped standard exposes only `test` and `exec`. No method builds a path from typed params. See P1, P3, and E1.

A `generate()` method is proposed, not shipped. Its own explainer excludes wildcards, regexp groups, and the `?`, `+`, `*` modifiers. Those constructs raise `TypeError`. See G1–G3.

The printable subset is therefore literal text plus bare named groups (`:id`). That subset excludes optional segments, catch-all tails, and refined params. Effect Frame's router needs exactly those for nested layouts and for schema-refined ids.

URLPattern's search component matches a query string as ordered text, not as a set of params. Reordering the query breaks the match. See E3. Search-param schemas cannot ride on the search component.

Foldkit's parser combinators print, compose, and carry an Effect Schema per segment and per query struct. See F1–F5.

This document records facts. It selects nothing.

## Runtime and browser availability

URLPattern reached Baseline "newly available" on 2025-09-15, when Safari 26 shipped it. Baseline "widely available" is projected for 2028-03-15. See B1.

| Target              | Version | Date       |
| ------------------- | ------- | ---------- |
| Chrome              | 95      | 2021-10-19 |
| Chrome Android      | 95      | 2021-10-19 |
| Edge                | 95      | 2021-10-21 |
| Firefox             | 142     | 2025-08-19 |
| Firefox for Android | 142     | 2025-08-19 |
| Safari              | 26      | 2025-09-15 |
| Safari on iOS       | 26      | 2025-09-15 |

Source: B1. A polyfill exists at [urlpattern-polyfill](https://github.com/kenchris/urlpattern-polyfill). See B2.

Server runtimes, measured locally:

| Runtime | Version | `typeof URLPattern` |
| ------- | ------- | ------------------- |
| Bun     | 1.4.2   | `function`          |
| Node    | 24.11.1 | `function`          |
| Deno    | present | `function`          |

Node 24 exposes `URLPattern` as a global. Earlier Node required `import { URLPattern } from 'node:url'`. See B3.

Commands: `bun -e 'console.log(typeof URLPattern)'`, `node -e '...'`, `deno eval '...'`.

Bun and Node returned identical results on every test in this document. The test script ran unchanged under both.

## Verified behaviour

Each row was run in Bun 1.4.2. Node 24.11.1 gave the same output.

| Id  | Input pattern and URL                                                   | Observed result                                                              |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| E1  | `p.generate` on any pattern                                             | `undefined`. The method does not exist.                                      |
| E2  | `/users/:userId/posts/:postId` vs `/users/42/posts/abc`                 | `{"userId":"42","postId":"abc"}`                                             |
| E3  | `search: "q=:term&page=:page"` vs `?page=2&q=a`                         | `false`. Order matters.                                                      |
| E3b | The same pattern vs `?q=a&page=2`                                       | `true`                                                                       |
| E3c | The same pattern vs `?q=a`                                              | `false`. No key is optional.                                                 |
| E4  | `pathname: "/s"` vs `/s?a=1&b=2`                                        | `true`. A path-only pattern ignores search.                                  |
| E5  | `/files/*` vs `/files/a/b/c.txt`                                        | `{"0":"a/b/c.txt"}`. Unnamed group.                                          |
| E6  | `/files/:rest*` vs `/files/a/b/c.txt`                                   | `{"rest":"a/b/c.txt"}`. Named tail.                                          |
| E7  | `/posts/:id{/edit}?` vs `/posts/7/edit` and `/posts/7`                  | `{"id":"7"}` for both. The optional group leaves no marker.                  |
| E8  | `/id/:n(\d+)` vs `/id/123` then `/id/abc`                               | `{"n":"123"}` then `false`. Refinement works on parse.                       |
| E9  | `hasRegExpGroups` on `/id/:n(\d+)` and on `/users/:id`                  | `true` then `false`                                                          |
| E10 | `/app/:tenant` vs `/app/acme/settings`                                  | `false`. A pattern matches the whole path.                                   |
| E11 | `/app/:tenant/*?` vs `/app/acme` and `/app/acme/settings`               | `true` for both. A tail must be declared.                                    |
| E12 | `"/app/:tenant" + "/settings/:section"` vs `/app/acme/settings/billing` | `{"tenant":"acme","section":"billing"}`. String concatenation composes.      |
| E13 | `/u/:name` vs `/u/a%2Fb` then `/u/a/b`                                  | `{"name":"a%2Fb"}` then `null`. Groups stay percent-encoded and stop at `/`. |
| E14 | `{ ignoreCase: true }` on `/Abc` vs `/abc`                              | `true`                                                                       |

Prototype members observed on a pattern instance: `constructor`, `protocol`, `username`, `password`, `hostname`, `port`, `pathname`, `search`, `hash`, `hasRegExpGroups`, `test`, `exec`. No print, build, generate, compile, or stringify member exists. See E1.

The `exec` result carries `inputs` plus one object per component. Each component object holds `input` and `groups`. There is no residual or unmatched-remainder field. See E10.

Unspecified components default to `*`. A pattern built from `{ pathname: "/only" }` reports `protocol`, `hostname`, `search`, and `hash` as `*`. See E4.

The test scripts live in the session scratchpad. They are short and reproducible from the table above.

## Specification facts

P1. The WHATWG URLPattern Standard defines two methods only: `test(input, baseURL)` and `exec(input, baseURL)`. `exec` returns a `URLPatternResult` or `null`. Component properties are read-only strings. `hasRegExpGroups` is a read-only boolean. `URLPatternOptions` carries one member, `ignoreCase`, default `false`. Source: [urlpattern.spec.whatwg.org](https://urlpattern.spec.whatwg.org/).

P2. The grammar derives from [path-to-regexp](https://github.com/pillarjs/path-to-regexp). It supplies named groups `:name`, full wildcards `*`, regexp groups `(...)` restricted to ASCII, the modifiers `?`, `+`, and `*`, group delimiters `{ }`, and `\` escapes. Part types are `fixed-text`, `regexp`, `segment-wildcard`, and `full-wildcard`. A bare `:name` is a segment wildcard: it stops at the component delimiter, `/` in pathname and `.` in hostname. Source: the same specification.

P3. The specification defines no operation that produces a URL or a component string from a pattern plus parameter values. The only outputs are a boolean and a match result. Source: the same specification. MDN states the same: URLPattern is "match/test only" with "no reverse-routing or URL-construction capability." Source: [MDN URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern).

P4. Constructor forms: `new URLPattern(init)`, `new URLPattern(patternString, baseURL)`, and either form plus an options argument. Source: the specification.

## The generate() proposal

G1. A `generate()` method is an early design sketch by the Chrome Loading team. The explainer states it "has not been approved to ship in Chrome." No spec PR and no Chrome flag version are named. Discussion lives in [whatwg/urlpattern#73](https://github.com/whatwg/urlpattern/issues/73), opened 2021-08-11. Source: [urlpattern-generate explainer](https://github.com/explainers-by-googlers/urlpattern-generate).

G2. The proposed signature:

```webidl
enum URLPatternComponent { "protocol", "username", "password", "hostname", "port", "pathname", "search", "hash" };
partial interface URLPattern {
  USVString generate(URLPatternComponent component, record<USVString, USVString> groups);
};
```

It generates one component at a time, not a whole URL. Source: the same explainer.

G3. Three construct classes are out of scope and raise `TypeError`:

- Full wildcards, the parts written `*`.
- Regexp groups, such as `/:id([0-9]+)`.
- Groups carrying the modifiers `?`, `+`, or `*`, "because they are essentially RegExp(s)."

The explainer says "support for these features will be suspended initially." A missing required group also raises `TypeError`. Extra keys are ignored. Source: the same explainer.

G4. Generation follows the existing URLPattern encoding rules through the basic URL parser. A hostname group becomes Punycode. A pathname group becomes percent-encoded. Source: the same explainer.

G5. The reversal hazard the discussion names is the wildcard. `*` maps to `.*`. An input such as `a/b/c` cannot be re-encoded unambiguously, because encoding the slash changes the path shape and not encoding it changes the segment count. Source: [whatwg/urlpattern discussion #41](https://github.com/whatwg/urlpattern/discussions/41).

G6. The stated motivation in discussion #41 matches this ticket: define a route once, then use it for both input matching and `<a>` targets or redirects, "without needing to define a thing twice." Source: the same discussion.

## Which subset prints

Combining G3 with E5–E8, the reversible subset under the proposal is:

| Construct            | Example        | Parses | Prints under the proposal |
| -------------------- | -------------- | ------ | ------------------------- |
| Literal text         | `/users`       | yes    | yes                       |
| Named segment group  | `/:id`         | yes    | yes                       |
| Regexp-refined group | `/:id([0-9]+)` | yes    | no, `TypeError`           |
| Full wildcard        | `/*`           | yes    | no, `TypeError`           |
| Named tail           | `/:rest*`      | yes    | no, `TypeError`           |
| Optional group       | `/:id{/edit}?` | yes    | no, `TypeError`           |
| Repeated group       | `/:seg+`       | yes    | no, `TypeError`           |

Today, with no shipped `generate()`, the printable subset is empty at the platform level. Any printing is application code. See E1 and P3.

E7 adds a second obstacle, independent of the proposal. An optional group leaves no trace in `groups`. `/posts/:id{/edit}?` returns `{"id":"7"}` for both `/posts/7/edit` and `/posts/7`. A printer cannot recover which URL produced the match. Round-tripping through URLPattern's own output is lossy for optional groups.

E13 adds a third. Groups come back percent-encoded and unsplit. `exec` returns `a%2Fb`, not `a/b`. A schema decoder must own the decoding step, because URLPattern hands over raw text.

## Nested layouts

URLPattern matches whole components, not prefixes. `/app/:tenant` does not match `/app/acme/settings`. See E10. A parent layout therefore cannot match a URL and hand a remainder to a child. The `exec` result exposes no remainder field. See P1.

Two composition routes exist, both in application code:

1. Declare a tail explicitly. `/app/:tenant/*?` matches the layout and its descendants, and the tail arrives as an unnamed or named group for a child matcher to re-parse. See E11 and E6.
2. Concatenate pattern strings before construction. `"/app/:tenant" + "/settings/:section"` builds one flat pattern that matches the full depth and yields both groups at once. See E12.

Route 2 keeps one match per URL and needs no re-parsing. It also loses the layout boundary: the composed pattern reports no split between the parent's segments and the child's. The framework must retain that split separately, because the pattern string does not carry it.

Route 2 breaks when a parent ends in a modifier. `"/app/:rest*" + "/settings"` constructs without error and matches `/app/a/settings`. See E12. The greedy tail silently swallows what the child meant to own. Composition is safe only when every parent is modifier-free, which is the same subset that `generate()` allows.

The platform contributes no nesting primitive. Composition is string concatenation with a framework-held boundary table.

## Search params

The search component is a pattern over the raw query string, not over a parsed param set. Three consequences follow from E3, E3b, E3c, and E4:

- Order is significant. `q=:term&page=:page` matches `?q=a&page=2` and rejects `?page=2&q=a`. A URL that users edit or that another site links cannot be relied on to preserve key order.
- Absence fails. The same pattern rejects `?q=a`. Optional keys need explicit optional groups per key, and the key count multiplies the alternatives.
- Omitting the component matches any query. `{ pathname: "/s" }` matches `/s?a=1&b=2`. See E4.

The workable arrangement is the third one. Let URLPattern own the pathname, ignore the search component, and hand `URLSearchParams` to a Schema decoder. The platform grammar contributes nothing to search-param typing. This is a separate mechanism, not the same one.

## Foldkit comparison

Source for this section: [Foldkit routing and navigation](https://foldkit.dev/core/routing-and-navigation).

F1. Foldkit calls its routes "biparsers: parsers that work in both directions." One definition serves both matching and building, with "no duplication between matchers and generators."

F2. Printing is the same value, applied. A router is a function:

```ts
const personRouter = pipe(literal("people"), slash(int("personId")), Route.mapTo(AppRoute.Person));

const personUrl = personRouter({ personId: 42 });
// '/people/42'
```

The documentation states TypeScript rejects a wrong-shaped argument at compile time.

F3. Segments carry Effect Schemas. `schemaSegment('id', MySchema)` decodes a segment through any schema. Branded and refined ids work:

```ts
const PersonId = Schema.FiniteFromString.pipe(Schema.brand("PersonId"));
```

A refinement failure falls through to the next router in `Route.oneOf` instead of reaching application logic. Compare E8: URLPattern refines with a regexp on parse only, and the refinement is a string test, not a typed decode.

F4. Query params carry a Schema struct:

```ts
Route.query(
  Schema.Struct({
    q: Schema.OptionFromOptional(Schema.String),
    page: Schema.OptionFromOptional(Schema.FiniteFromString),
    sort: Schema.OptionFromOptional(Schema.Literals(["Asc", "Desc"])),
  }),
);
```

`Schema.OptionFromOptional` makes a key optional; an absent key decodes to `Option.none()`. `Schema.FiniteFromString` converts to a number. The documentation notes that `Schema.withConstructorDefault` does not supply query defaults, and directs users to `Schema.withDecodingDefaultKey`. Query params are a keyed set, so order does not matter. Compare E3.

F5. Routes are declared as a schema union:

```ts
const AppRoute = defineRouteUnion({
  Home: {},
  People: { searchText: Schema.Option(Schema.String) },
  Person: { personId: Schema.Number },
  NotFound: { path: Schema.String },
});
```

The result is both a runtime schema, storable in the Model, and a type.

F6. Combinators: `literal`, `int`, `string`, `schemaSegment`, `rest`, `restString`, `slash`, `Route.query`, `Route.mapTo`, `Route.oneOf`, `Route.parseUrlWithFallback`. A router "only matches when it consumes the entire URL, so routes that share a prefix do not conflict." That whole-consumption rule matches URLPattern's behaviour in E10.

F7. Foldkit's documentation describes no nested route or nested layout primitive. Views dispatch through `AppRoute.match`, each arm delegating to its own view function, and layout wrapping is manual around the matched content. Composition happens with `pipe` and `slash` over flat routers, not through a layout tree.

F8. `rest('path')` requires at least one segment and yields `NonEmptyArray<string>`. `restString('path')` yields one slash-joined string. Nothing may follow `rest` in the path, though `Route.query` may. Compare E12, where URLPattern permits a segment after a tail and matches it, which is the silent-swallow hazard.

F9. Transitions use `Transition.make(previous, next)` and `Transition.coldLoad(next)`, with `entered`, `enteredAny`, `exited`, `exitedAny`, `stayed`, and `isEntering`. `stayed` returns both sides for diffing. This matches the route lifecycle already settled in `docs/design/progressive.md`.

## Side by side

| Point                      | URLPattern                                                                                                                                               | Foldkit routes                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Printing from typed params | None shipped. `generate()` is an unapproved sketch, one component at a time, excluding wildcards, regexps, and modifiers. P3, G1, G3.                    | Built in. The router is the builder. `personRouter({ personId: 42 })`. F1, F2.                               |
| Printable subset           | Literals and bare `:name` only, once the proposal ships. Optional groups are additionally lossy on parse. G3, E7.                                        | Every combinator, including `rest` and `schemaSegment`. F3, F8.                                              |
| Nested layouts             | No primitive. Whole-component match, no remainder. Composition is string concatenation, unsafe after a modifier. E10, E12, P1.                           | No primitive either. Flat routers composed with `pipe` and `slash`; layouts wrapped manually. F7.            |
| Search-param schema        | Ordered text match over the raw query. Reordering fails, absence fails. Practically: omit the component and decode `URLSearchParams` separately. E3, E4. | `Route.query(Schema.Struct(...))`, keyed and order-free, with `OptionFromOptional` and coercing schemas. F4. |
| Param refinement           | Regexp string test on parse. Blocks printing under the proposal. E8, G3.                                                                                 | Any Effect Schema, including brands. Failure falls through `oneOf`. F3.                                      |
| Decoding                   | Raw percent-encoded strings. E13.                                                                                                                        | The schema decodes. F3.                                                                                      |
| Platform cost              | Zero dependency in Bun, Node 24, Deno, and all current browsers. Polyfill for older browsers. B1, B2, B3.                                                | A library dependency. Already an Effect Schema consumer.                                                     |

## Implications for Effect Frame

`docs/design/progressive.md` settles the route style as "schema-first and bidirectional: a route parses and prints. Templates use the platform's URLPattern grammar." The findings bear on the second sentence, not the first.

Printing is not in the platform. Whatever Effect Frame ships, the printer is framework code. URLPattern supplies no help today and, under the current proposal, no help for tails, optional segments, or refined params.

"The URLPattern grammar" and "the URLPattern object" are separable. The grammar is a familiar, portable notation that a framework can parse itself and use to drive both a matcher and a printer. The object is a matcher that discards the structure a printer needs. Adopting the grammar does not require adopting the object.

Three constraints hold whichever way that separation goes:

- Search params need their own mechanism. The search component cannot carry a Schema, because it matches ordered raw text. See E3. A pathname pattern plus a Schema over `URLSearchParams` is the arrangement that works.
- Nested layouts need a framework-held boundary table. Neither URLPattern nor Foldkit supplies a nesting primitive. See E10 and F7. The map commits to nested layouts, so this is Effect Frame's own design surface either way.
- Param refinement and printing pull in opposite directions under URLPattern. A regexp-refined id parses but cannot print. See E8 and G3. Foldkit gets both from one schema. See F3.

The route lifecycle already settled on Foldkit's Transition. See F9. Foldkit's combinators and this repository's Effect Schema usage share a vocabulary that the URLPattern object does not.

No decision is recorded here.

## Sources

- B1. [URLPattern, web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/urlpattern/). Baseline newly available 2025-09-15; widely available projected 2028-03-15; per-browser versions.
- B2. [urlpattern-polyfill](https://github.com/kenchris/urlpattern-polyfill).
- B3. [New URLPattern API brings improved pattern matching to Node.js and Cloudflare Workers](https://blog.cloudflare.com/improving-web-standards-urlpattern/). Node 24 exposes the global.
- P1–P4. [URLPattern Standard, WHATWG](https://urlpattern.spec.whatwg.org/).
- [MDN, URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern).
- G1–G4. [urlpattern-generate explainer, explainers-by-googlers](https://github.com/explainers-by-googlers/urlpattern-generate).
- [whatwg/urlpattern issue 73, consider generating URL strings from a URLPattern](https://github.com/whatwg/urlpattern/issues/73).
- G5, G6. [whatwg/urlpattern discussion 41, Support for Compile](https://github.com/whatwg/urlpattern/discussions/41).
- F1–F9. [Foldkit, routing and navigation](https://foldkit.dev/core/routing-and-navigation).
- E1–E14. Local runs in Bun 1.4.2 and Node 24.11.1 on Darwin 24.6.0, 2026-09-18.
