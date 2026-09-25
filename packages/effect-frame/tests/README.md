# Tests

Each top-level folder runs in its own `bun test` process (`test:actor`,
`test:view`, `test:router`). The view and router suites register happy-dom
as the process's globals (the router with `http://app.test/` as the origin),
and the actor suite talks to a real socket through the platform `fetch`.
One process for all three would make the first registration win and the
socket tests answer to a fake `fetch`.

Every suite runs with `--conditions=development`, so it loads the
development build of `@solidjs/signals`, as the examples' browser bundles
do. That build refuses a signal write inside a reactive owner,
which the production build lets pass: a test on the production build can go
green while the page it models draws nothing.
