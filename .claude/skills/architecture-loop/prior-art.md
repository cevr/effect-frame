# Prior art

Fetch with `okra repo fetch <slug>`; get the path with `okra repo path <slug>`. `okra repo list` prints hundreds of kilobytes; use `path`. When a cached repo is on the wrong branch, `git fetch origin <branch>` and read `origin/<branch>`.

| Slug              | Branch      | Read it for                                                                                                                                                                                                                                                                            |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remix-run/remix` | `main` (v3) | Web-platform-first server and forms. `packages/fetch-router/src`, `packages/route-pattern/src` (`href.ts`, `match.ts`), `packages/ui/src/runtime` (`frame.ts`, `navigation.ts`, `form-navigation.ts`, `reconcile.ts`), `packages/ui/src/server/stream.ts`, `packages/form-data-parser` |
| `solidjs/solid`   | `next` (v2) | Fine-grained reactivity, the view layer effect-frame renders on. `packages/signals/src` (`signals.ts`, `boundaries.ts`, `affects.ts`, `store/`), `packages/solid/src/{client,server}`                                                                                                  |
| `sveltejs/svelte` | `main`      | Compiled reactivity and async work. `packages/svelte/src/internal/client/reactivity` (`batch.js`, `async.js`, `deriveds.js`, `effects.js`), `internal/client/hydratable.js`, `internal/server`                                                                                         |
| `facebook/react`  | `main`      | Transitions, optimistic state, streaming. `packages/react-reconciler/src/ReactFiberHooks.js` (`useOptimistic`, `useActionState`), `ReactFiberTransition.js`, `ReactFiberHydrationContext.js`, `packages/react-server/src/ReactFizzServer.js`, `ReactFlightReplyServer.js`              |
| `foldkit/foldkit` | `main`      | The Elm architecture in Effect: the closest neighbour. `packages/foldkit/src/runtime` (`makeApplication.ts`, `messageQueue.ts`, `dispatch.ts`, `hydrationHandoff.ts`), `command/`, `message/`, `route/` (`parser.ts`, `transition.ts`), `managedResource/`, `asyncData/`               |

## What to compare

- **Remix v3:** route patterns that print what they parse, forms that work without JavaScript, the server as a plain `fetch` handler. Compare with `src/router` and `src/actor/http`.
- **Solid v2:** ownership, boundaries, and async reads. effect-frame depends on it, so a finding here is often a misuse, not a design idea.
- **Svelte:** batching and async deriveds. Compare with query readiness and the view runtime.
- **React:** `useOptimistic` and action state against `src/actor/provisional.ts`; Fizz streaming against the streaming SSR work; hydration mismatch handling against `src/view`.
- **Foldkit:** one message queue per application against one mailbox per actor; commands as values against `CommandHandle`; managed resources against scoped `Layer`s; its DevTools against `src/inspection`.

## Settled comparisons

None yet. Add a line here when a comparison is decided, with the ledger row that decided it. A later pass reads this list first and does not survey a settled question again.
