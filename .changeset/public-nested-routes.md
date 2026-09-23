---
"effect-frame": minor
---

Publish nested routes on the `Route` namespace of `effect-frame/router`, and `View.lazy` on `effect-frame/view`.

New exports on `Route`:

- Addresses: `segment`, `child`, `Segment`, `SegmentOptions`, `AnySegment`. A segment's type holds only its name, parent, search keys, printers, and `currentAt`.
- Branches: `leaf`, `layout`, `Branch`, `AnyBranch`, `Tree`, `BranchRejected`. Segments and branches are branded: only the constructors make them.
- Mount: `client(name, root)` mounts a tree from a branch of a root segment. `client(name, definition)` stays the flat form. It is now the one-leaf shorthand of the same model and runs on the same runtime.
- Data: `query`, `actor`, `Declaration`, `Declarations`, `QueryDeclaration`, `ActorDeclaration`, `RouteData`, `Values`. A segment with declarations requires `data`.
- Props: `SegmentProps`, `LayoutProps`, `PropsOf`, `LayoutPropsOf`. Segment views get `href`, `updateSearch`, and `replaceSearch`.
- Presentation: `Pending`, `Presentation`, `Recovery`.
- Checks: `target`, `redirect`, `Continue`, `Target`, `Redirect`, `Verdict`, `Before`, `BeforeInput`, `NavigationKind`, `Printable`, `RouteFailure`, `CheckNavigation`, `RedirectCycle`.
- Links: `Linkable` (the shape `link` accepts) and `Current` (`"page" | "ancestor" | "none"`).

New on `Link`: `current: Source<Route.Current>`. `Link` draws `aria-current="page"` on the destination and `aria-current="true"` on a segment the URL continues below. A segment is never current on not-found or on another route.

New exports on `View`: `lazy`, `LazyImportFailed`, `LazyModule`.

Leave checks, the browser commit, and navigation receipts stay private (#56).

Migration:

- Routes built with `Route.client(name, definition)` need no source change.
- `link` now takes `<Params, Search>` (decoded types) and accepts a flat route or a segment. Remove explicit type arguments: `link<"book", typeof P, typeof S, never>(book, ...)` becomes `link(book, ...)`. Inferred calls do not change.
- `Route.Route` now extends `Linkable`, so it also has `searchAt` and `currentAt`. A `Route` object written by hand must add both.
- `Route.client` is overloaded. A wrong flat definition is reported as TS2769, with the flat form's own error below it on the same property.
- A flat route's `params` and `search` Sources now publish together, and only when the raw path record or the route's encoded search changes. A hash-only move, a write of a key the route does not decode (such as a `UrlState` key), a reordered query, and a search that decodes and encodes the same publish nothing. A raw path change that decodes to equal params (`/books/05` after `/books/5`) still publishes.
