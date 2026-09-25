---
"effect-frame": minor
---

`Route.redirect` takes its destination directly, as `link` does: `Route.redirect(segment, params, search)`. `Route.target`, `Route.Target`, and `Route.Printable` are removed, and `Route.Redirect` carries the printed `href`. `Route.Linkable`, the one destination type, gains `href`.

Add `Route.redirecting(name, segment, to)`: a route that only redirects. It has no view and no rendering mode; `to` receives the candidate's params, search, URL, and kind, and answers the `Route.redirect`. The segment's own `before` runs first.

```ts
const home = Route.segment("home", { path: "/", params: Schema.Struct({}) });
export const Home = Route.redirecting("home", home, () =>
  Effect.succeed(Route.redirect(lists, {}, {})),
);
```
