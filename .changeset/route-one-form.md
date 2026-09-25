---
"effect-frame": minor
---

The flat route form is removed. Every rendering-mode constructor (`Route.client`, `Route.ssr`, `Route.streamed`, `Route.awaitAll`, `Route.prerender`, `Route.driven`) takes a root segment's branch only. A one-page route is a tree of one leaf:

```ts
const login = Route.segment("login", { path: "/login", params: Schema.Struct({}) });
const Login = Route.client("login", Route.leaf(login, LoginView));
```

Link, target, and print through the segment (`link(login, …)`, `login.href(…)`), not the route. `Route.Route`, `Route.RouteDefinition`, `Route.DrivenDefinition`, `Route.PrerenderDefinition`, `Route.DrivenConstructor`, and the flat `RouteOf` and `RouteDefinition` exports are gone. A flat `behavior` field is the leaf's option; a flat prerender's `inputs` is `{ inputs: [Route.inputs(segment, enumerate)] }`.
