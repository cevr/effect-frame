---
"effect-frame": patch
---

The published declarations no longer widen types that cross the package's own subpaths. A clean build emitted them before `dist` existed, so `effect-frame/actor/client` and `effect-frame/view` did not resolve, and the emitter wrote `any` or `unknown` with no error. `hydrate` returned `Effect<{ report: any; resumed: any }, unknown, unknown>`, `Driven.session` had `unknown` error and requirements, `View.select` was `any`, `addressOf` and `Remote.resume` had `any` requirements, and `PrerenderQueryFailed.error` was `any`. The declarations are now emitted from source, and each of these types is the one the source infers.
