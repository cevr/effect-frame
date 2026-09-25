# Authorization and revocation

> Decision record: it explains a choice as of its day, and its code may be
> out of date. The reference is [the package README](../../packages/effect-frame/README.md)
> and the JSDoc.

Date: 2026-09-23. This file records what ticket #85 built from the decided
designs of [#20](https://github.com/cevr/effect-frame/issues/20) (one
required policy model for actors and queries) and
[#30](https://github.com/cevr/effect-frame/issues/30) (a live connection
learns that its principal changed). It also records where the build differs
from those designs, and why.

## Files

- `packages/effect-frame/src/actor/principal.ts` — `Principal`,
  `Anonymous`, `Authenticated`, `Claims`, `CurrentPrincipal`,
  `PrincipalSource` (client-safe).
- `packages/effect-frame/src/actor/policy.ts` — `Policy`, `Policies`,
  `PolicyTable`, `Subject`, `Action`, `PolicyNamesMissing` (server only).
- `packages/effect-frame/src/actor/host.ts` — validates the table and
  authorizes every actor verb.
- `packages/effect-frame/src/actor/query-host.ts` — authorizes every query
  read with the same table.
- `packages/effect-frame/src/actor/http/server.ts` — derives the principal
  per request and ends a changes stream when it changes.
- `packages/effect-frame/src/actor/http/client.ts` — decodes the terminal
  error event and never retries `Unauthorized`.
- `packages/effect-frame/src/actor/http/form-post.ts` — the plain-form route
  derives the same principal and sends an anonymous refusal to login.
- Proofs: `packages/effect-frame/tests/actor/policy.test.ts`,
  `revocation.test.ts`, `remote.test.ts`, `http.test.ts`, `query.test.ts`,
  `boundary.test.ts`, and the shared `auth-fixture.ts`.

## Decisions built

### One policy model (#20 §2)

- A policy is `check(principal, subject, action)`. It returns `void` or
  fails with `Unauthorized`.
- A subject is `{ _tag: "Actor", address }` or `{ _tag: "Query", key }`.
  An action is `"read"` (snapshot, changes, query) or `"send"` (send,
  call).
- Every contract names a policy (`contract(name, { policy, ... })`), and
  every query names one (`query(name, { policy, ... })`). The field is
  required. The literal name is kept in the contract's type.
- The host reads its rules from `Policies`, a `Context.Service` that holds
  a `PolicyTable` (name to rule). It is a service and not a reference, so
  it has no default. A host with no table does not typecheck.
- Combinators: `Policy.allowAll`, `Policy.authenticated`, `Policy.of`,
  `Policy.all`, `Policy.any`, `Policy.byAction`.
  `Policy.of` refuses an anonymous caller, and a subject its `decode` function does
  not recognize, before its `check` function runs.

### Allow-all is a name (#20 §3)

- The old `Authorizer` service, its allow-all default, `QueryPolicies`,
  `allowAll`, and the query's `publicPolicy` default are removed.
- Allow-all exists only as `Policy.allowAll`, registered under a name the
  application chose. `apps/notes` registers it as `public`.

### Validation at construction (#20 §3)

- `ActorHost.make` and `ActorHost.layer` read
  `Policies` before they build anything. When the table lacks any declared
  name, they fail with `PolicyNamesMissing`, which lists every miss
  (actor or query, declaring name, policy name).
- `PolicyMissing` stays in the query wire vocabulary, so the wire does not
  change. No host produces it: the host resolves every declared name to its
  rule when it builds, and a check reads the resolved rule.

### The principal (#20 §1)

- `Principal` is `Anonymous` or `Authenticated { subject, claims }`.
  `Claims` is a JSON record.
- `CurrentPrincipal` is a `Context.Reference` with the default
  `Anonymous`. The default grants nothing, because every name resolves to a
  rule and a rule that does not name `Anonymous` refuses it.
- The host authorizes in this order: find the contract, check the policy,
  open the instance. A refused caller never opens an instance.

### Derivation and revocation (#30)

- `HttpServer.make({ prefix, principal, maxBodyBytes, form })` requires a
  derivation: `(request) => Effect<PrincipalSource, never, R>`.
  `HttpServer.anonymous` is the named derivation for a host with no
  sessions. It runs once per request, for the JSON verbs and the form
  route alike.
- A `PrincipalSource` has `get` for one request and `changes` for a
  connection. `changes` emits `PrincipalRevision { principal, revision }`:
  the current principal first, then each change with a larger number.
  `Principal.revisions(stream)` numbers a principal stream, and gives a
  value that is equal to the one before it (`Principal.equals`) no number.
  `Principal.fromSource(source)` makes a `PrincipalSource` from a
  `Source<Principal>`. `Principal.constant(p)` never changes, and
  `Principal.anonymous` is the anonymous one.
- Every verb but `changes` reads `get` once and runs under
  `CurrentPrincipal`.
- A changes stream opens one subscription to the source's `changes`. The
  first value of that subscription is the principal it authorizes under
  (`Stream.peel`), and the rest of the same subscription is what it
  watches. It ends with `Unauthorized` on the first revision with a larger
  number than the connected one. Because the read and the watch are one
  subscription, a change and a change back between them (A, B, A) still
  ends the stream. A session revision that leaves the principal equal,
  such as a `Touch` that slides `expiresAt`, gets no number and ends
  nothing.
- `HttpServer.shareSessions({ read, follow })` keeps one subscription per
  session key in an `RcMap` of shared streams. It numbers the revisions
  once, before the share, so every connection compares the same numbers.
  The share buffers the latest revision only: capacity 1, sliding,
  replay 1. A connection that falls behind keeps only the newest revision,
  so no buffer grows with the number of changes. A skipped revision is
  safe: the newest one still has a larger number, so A, B, A still ends
  the stream when the connection never saw B. The first connection on a
  key opens the subscription, later connections join it and see its latest
  revision first, and the last connection to close releases it. The test
  counts subscriptions, not only actor instances.
- A session is an actor. Expiry is a machine task that sleeps until
  `expiresAt` and commits `Empty`. No timer exists per connection.
- N connections on one session share one session subscription and one
  hosted session instance.
- The HTTP client never retries `Unauthorized`. The reconnect schedule is
  guarded with `Schedule.while`, so a revoked stream fails at once.
- A client query cache never keeps a value past its principal. The cache
  counts principal generations. `QueryCache.principalChanged` starts the
  next generation, and every live entry drops its value and any read in
  flight, shows `Loading`, and reads again.
- The generation starts on every `Unauthorized` that proves a change:
  - An actor reference's change stream ends with `Unauthorized`. Its
    snapshot was authorized, so the principal changed under it.
  - A reference's `send` or `call` is refused with `Unauthorized`. The
    client cannot tell a changed principal from one that may read but not
    send, so a refused command costs one fresh read of each live entry.
    Nothing reads again on its own after it, so it cannot loop.
  - A query read is refused with `Unauthorized` for a key that the server
    granted under the same generation. A key that was never granted under
    it is only refused: that is the answer for this principal, not news.
    This rule is what stops a loop. Each new generation needs a new grant
    before a refusal can start the next one.
  - A scripted form sends through a reference, so its refusal is a
    refused command. A plain form post is a navigation and has no client
    cache.
- Each held state carries the generation it was written under, and each
  read in flight carries the entry's read stamp, which a new generation
  bumps. A result from an older stamp is dropped.
- A command claim records the generation when the command starts. If the
  generation moved before the reply settles, the reply's refreshes were
  read for somebody else: none of them lands, and the entries read again
  on their own.
- `followQuery` keeps the last value on screen, stale, while the next key
  loads, but only within one generation. A `Loading` from a later
  generation is shown as it is, and a state from an earlier one is
  dropped. `QueryState` does not change: the generation is a stamp inside
  the cache that only `followQuery` reads.
- `HttpServer.make` and celld's `defineFrameHost` keep the derivation's
  requirements `R` and supply them from the context the handler was
  built in.

### Streamed documents (#22 with #85)

- **Decision.** A server render (`Html.renderToStream`,
  `Html.renderAwaitAll`) reads its queries under the request's principal.
  The caller provides `CurrentPrincipal` to the render, from the same
  derivation that serves the request. The default is `Anonymous`, and it
  grants nothing.
- Each render builds its own cache (#28), and the render's queries go
  through `ActorTransport` to the host. So every render read is checked
  by the same policy as `POST /query`. The cache key does not name the
  principal. Never share a render cache between requests.
- A refused render read writes an `Unauthorized` patch, never the value.
  `Unauthorized` is not final in a seed (#22): the client lands it and
  reads the key again at once, under its own principal.
- A seed that a slot takes lands through the slot and gets the client's
  generation at that moment, like any other read. When the client's
  generation moves before hydration:
  - A seed that no slot took yet is dropped. The cache expires the
    document, and a key declared later reads over the query path.
  - A seed that a slot waits for is dropped by the slot's `forget`, which
    bumps the slot's read stamp.
  - A seed that already landed is forgotten with every other value.
- Proofs: `packages/effect-frame/tests/view/streaming-auth.test.tsx`,
  "an anonymous render of a protected query writes the refusal, never the
  value", "the same render under a signed-in principal writes the value",
  and "a seed no view took yet does not survive a principal change".

### Recovery with no caller

- `ActorHost.layer` provides `ActorHost.Recovery` beside the transport.
  `wake(address)` opens the actor, which restores its state, drains the
  commands already admitted, and re-enters machine work.
- It checks no policy. It serves nothing and returns no state, and every
  command it drains was authorized when it was admitted. It is never on
  the wire.
- The celld alarm uses it. Before this, the alarm sent itself an anonymous
  `/snapshot` through the public handler, and a protected actor refused it,
  so admitted commands stayed pending after a restart.

### Navigation and command refusals (#20 §5)

- The plain-form route (the `form` option of `HttpServer.make`) runs under
  the handler's one `principal` and requires `login: Option<string>`.
- An anonymous caller that is refused gets a 303 to the login path with
  `next` set to the posted `$return`. The submitted body is not kept.
- An authenticated caller that is refused gets 403 with the rendered page.
  A login redirect would be a lie: signing in again changes nothing.
- With `login: Option.none()`, every refusal is a 403 with the page.
- Command verbs (`send`, `call`, `query`, `snapshot`) keep 403 with a
  decodable `Unauthorized`.

## Differences from the designs

- **Module name.** The policy module is `policy.ts`. The `.server` suffix
  cannot be used: the lint rule `no-restricted-imports` forbids a
  non-server module (`host.ts`, `query-host.ts`, `index.ts`) from importing
  a `*.server` file. The client bundle test proves that the client entry
  holds no policy table.
- **Revocation comparison.** The design reads `get`, then compares each
  change with the previous one (`drop(1)`). The build takes the connected
  principal from the first revision of the watched subscription, and ends
  at any later revision. A separate `get` and a later subscription can
  miss a change and a change back, because a new subscriber sees only the
  current value.
- **Refusal at connect.** A changes request that is refused at connect
  answers 200 and a terminal `event: error` with the encoded
  `Unauthorized`, not a 403 before the stream opens. The client decodes an
  error event the same way before and after the first projection.
  Before #85, the client decoded an error event as a projection and died.
- **The anonymous source.** #30 §4 gives `HttpServer.anonymous` an empty
  `changes` stream. The build gives it one value and then the end, because
  every `Source` emits its current value first. It has no later revision,
  so it ends nothing, and the stream holds no subscription.
- **Generic derivation.** `ServerOptions.principal` is generic in its
  requirements `R`. The derivation runs in the context `HttpServer.make`
  was built in, so a derivation can read the session actor through
  `ActorTransport`.
- **Route policies.** The `Route` subject and the router's policy hook are
  not built. They belong to the Auth example rows in the acceptance matrix
  ("A route policy is resolved before any declared data", "Route policies
  accumulate").
- **celld.** `FrameHostOptions` requires `principal`, and its `layer` must
  provide `Policies`. A missing name surfaces as `PolicyNamesMissing` on the
  first request or alarm, because the runtime is built lazily. The alarm
  wakes through `ActorHost.Recovery`, not through the public wire.

## Gaps

- **Typed policy names.** `PolicyTable` is a string index. The host checks
  at construction that every declared name is in the table, but the type
  does not correlate the table's keys with the literal names the contracts
  declare. A typed host builder could infer them from the implementations.

- **Session reads.** #20 names the session's policy `sessionOwner`: only
  the same subject, or an anonymous `SignIn` on an empty session. But the
  derivation reads the session before any principal exists, so it reads as
  `Anonymous`. The test fixture therefore registers its `session` policy as
  `Policy.allowAll`: the session key is the secret the cookie carries.
  A real application needs the derivation to read under a system principal,
  or a read rule that trusts the key. This needs a grilling ticket.
- **CSRF.** #20 decided nothing about CSRF, and #85 builds no origin check.
  With a cookie-derived principal, CSRF is real for the plain-form route.
  It is also real for the JSON routes, because a cross-site form can post a
  `text/plain` body. Until a ticket decides it, set the session cookie with
  `SameSite=Lax` or `SameSite=Strict`. This needs a grilling ticket.
