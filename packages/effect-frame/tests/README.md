# Tests

Each top-level folder runs in its own `bun test` process (`test:actor`,
`test:view`, `test:router`). The view and router suites register happy-dom
as the process's globals (the router with `http://app.test/` as the origin),
and the actor suite talks to a real socket through the platform `fetch`.
One process for all three would make the first registration win and the
socket tests answer to a fake `fetch`.
