---
"effect-frame": minor
---

Require a named policy for every actor and query, and end a live connection when its principal changes (#20, #30).

New exports on `effect-frame/actor`: `Policy` (`allowAll`, `authenticated`, `of`, `all`, `any`, `byAction`), `Policies`, `PolicyNamesMissing`, `MissingPolicy`, and the types `PolicyTable`, `Subject`, `Action`. `HttpServer.anonymous` and the type `HttpServer.DerivePrincipal`.

New exports on `effect-frame/actor/client`: `Principal` (`anonymous`, `constant`, `equals`, `fromSource`, `isAuthenticated`, `revisions`), `Anonymous`, `Authenticated`, `Claims`, `CurrentPrincipal`, and the types `PrincipalSource` and `PrincipalRevision`. A `PrincipalSource`'s `changes` emits numbered revisions, and a connection ends at the first revision after the one it connected under.

Breaking changes:

- `contract(...)` and `query(...)` require `policy`, a policy name.
- `ActorHost.make`, `ActorHost.layer`, and `ActorHost.layerMemory` require `Policies` and fail with `PolicyNamesMissing` when the table lacks a declared name. `ActorTransport.layerLocal` and `QueryCache.layerTest` carry the host's error and requirements.
- Removed: `Authorizer`, `AuthorizerService`, the host's `Action`, `QueryPolicies`, `QueryPolicy`, `allowAll`, and `publicPolicy`. Write `Policy.allowAll` under a name instead.
- `HttpServer.make` takes `{ principal }`. `HttpServer.toWebHandler` takes the same options.
- `HttpServer.form` requires `principal` and `login: Option<string>`. An anonymous refusal answers 303 to `login` with `next`.
- `FrameHost` options require `principal`, and the host layer must provide `Policies`.
- The HTTP client never retries `Unauthorized`, and decodes a terminal `event: error` on a changes stream.
- `HttpServer.toWebHandler` and `defineFrameHost` keep the derivation's requirements and supply them from their runtime.
- `ActorHost.layer` and `ActorHost.layerMemory` also provide `ActorHost.Recovery`. The celld alarm wakes through it, not through the public wire.
- `QueryCacheService` has `principalChanged`. A custom cache must implement it. The built-in cache starts a new principal generation on a reference's `Unauthorized` stream end, a refused `send` or `call`, and a refused read of a key it was granted under the same generation. A reply that settles after a new generation does not land, and `followQuery` does not carry a value across generations.

Also new: `HttpServer.shareSessions` (one subscription per session, shared by every connection, with a bounded `HttpServer.sessionBuffer` of the latest revision), `HttpServer.SessionPrincipals`, and `HttpServer.SessionBuffer`.
