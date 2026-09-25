---
"effect-frame": minor
---

`effect-frame/view` follows one kind rule: a flat PascalCase value is a JSX tag (`For`, `Show`, `Match`, `Portal`, `Await`) or a namespace (`View`, `Dom`, `Html`, `Remote`), and every function and Effect is a lowercase member of `View`. A type test guards it.

| Before                                 | After                                                 |
| -------------------------------------- | ----------------------------------------------------- |
| `Loading({ fallback, children })`      | `View.loading({ fallback, content })`                 |
| `Errored({ fallback, children })`      | `View.errored({ fallback, content })`                 |
| `ready`, `orErrored`, `readyWithStale` | `View.ready`, `View.orErrored`, `View.readyWithStale` |
| `LoadingScope`, `ErroredScope`         | `View.LoadingScope`, `View.ErroredScope`              |
| `mount(view, props, host, root)`       | `View.mount(view, props, host, root)`                 |
| `render` (it only flushes)             | `View.flush`                                          |
| `<Query state loading failed ready>`   | `<Await state loading failed ready>`                  |
| `Await({ query, ... })`, an Effect     | removed: use the `<Await>` tag, whose prop is `state` |
| `QueryProps`                           | `AwaitProps`                                          |

The boundaries stay Effects: they run their content's setup with the scope provided and remove it from `R`, which a synchronous tag cannot do. `content` replaces `children` so the call does not read as a tag.
