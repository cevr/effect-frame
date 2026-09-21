---
"effect-frame": minor
---

Typed links. `Route.link(route, params, search)` yields a `Link` in a view's setup: the href printed through the route's own Schemas, `active` (a source, `true` while the document is on that route), and `go(options)`. `<Link link={l} replace class>` draws it as an anchor with a real `href` and `aria-current="page"`. `router.current` is a source of the current match (route name and URL), and `isActive(router, route)` derives from it.
