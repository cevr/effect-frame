---
"effect-frame": minor
---

Publish nested routes on the `Route` namespace of `effect-frame/router`, and `View.lazy` on `effect-frame/view`.

New exports on `Route`:

- Addresses: `segment`, `child`, `Segment`, `SegmentOptions`, `AnySegment`.
- Branches: `leaf`, `layout`, `Branch`, `AnyBranch`, `Tree`, `BranchRejected`.
- Mount: `client(name, root)` mounts a branch tree. `client(name, definition)` stays the flat form. It is now the one-leaf shorthand of the same model and runs on the same runtime.
- Data: `query`, `actor`, `Declaration`, `Declarations`, `QueryDeclaration`, `ActorDeclaration`, `RouteData`, `BindingOf`, `Values`, `Disjoint`, `NoDeclarations`.
- Props: `SegmentProps`, `LayoutProps`, `PropsOf`, `LayoutPropsOf`. Segment views get `href`, `updateSearch`, and `replaceSearch`.
- Presentation: `Pending`, `Presentation`, `Recovery`, `RecoveryFor`.
- Checks: `target`, `redirect`, `Continue`, `Target`, `Redirect`, `Verdict`, `Before`, `BeforeInput`, `NavigationKind`, `Printable`, `RouteFailure`, `CheckNavigation`, `RedirectCycle`.
- `Linkable`: the shape `link` accepts.

New exports on `View`: `lazy`, `LazyImportFailed`, `LazyModule`.

Leave checks, the browser commit, and navigation receipts stay private (#56).

Migration:

- Flat routes need no source change.
- `link` now takes `<Params, Search>` (decoded types) and accepts a flat route or a segment. Drop explicit type arguments from `link` calls. Inferred calls do not change.
- A flat route's `params` and `search` Sources now publish only when the matched values change. A hash-only navigation no longer republishes equal values.
