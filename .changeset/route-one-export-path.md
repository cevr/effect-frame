---
"effect-frame": minor
---

The router's types have one export path, under `Route`: import `Route.AnyRoute`, `Route.PathRecord`, `Route.SearchRecord`, `Route.Entered`, and the rest from the namespace; the flat duplicates on `effect-frame/router` are gone, with `searchKeysOf`, `UrlStateOptions`, `UrlStateState`, and `RouteLink` (use `UrlState.Options`, `UrlState.State`, and `Link`). `Route.printPath`, `Route.mergeSearchRecord`, `Route.searchKeysOf`, `Route.SearchSchemaRejected`, `Route.SegmentProps`, and `Route.LayoutProps` are no longer exported: type a view's props with `Route.PropsOf<typeof segment>` or `Route.LayoutPropsOf<typeof segment, ChildR>`. `Route.printSearch` stays, as `Route.readSearch`'s inverse for an opaque search codec.
