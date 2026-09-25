---
"effect-frame": minor
---

An open readiness scope is a compile error where a view's services are
final, named by its fix. `View.mount`, `Html.renderToString`,
`Html.renderToStream`, `Html.renderAwaitAll`, `Remote.draw`,
`Remote.client`, `Driven.session`, a router's `notFound` view, and every
`Route` mode constructor (`client`, `ssr`, `streamed`, `awaitAll`,
`prerender`, `driven`) take `View<P, E, R> & ScopesClosed<R>`. A
`View.ready` with no `View.loading` above it reports
`Property '"View.ready needs a View.loading above it"' is missing`, and a
`View.orErrored` with no `View.errored` above it names that pair, at the
call, instead of surfacing as `LoadingScope` where the application provides
its layers. The `ScopesClosed<R>` type is exported from
`effect-frame/view`; a generic helper that forwards a view to `View.mount`
states it on its own parameter.
