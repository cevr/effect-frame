# Live inspection gateway (private proof)

Status: private transport proof for #58. There is no public export, no
Changeset, no new published package, and no `bin` field. The proof lives in
the private workspace `tooling/inspection-gateway`. Root decides the public
boundary from the evidence below.

A browser Frame root holds the state that a reader wants: mounted routes,
query slots, local actors, and URL claims. A server process cannot inspect
that memory. The reader must reach the browser root that owns it.

## Transport choice

A browser cannot listen for connections. It can only originate a WebSocket.
The proof therefore reverses the RPC roles over one browser-originated socket:

```
reader (CLI) --HTTP--> gateway (Bun, loopback) <--WebSocket-- browser root
                        RpcClient per root          RpcServer over one socket
```

- The browser dials `ws://127.0.0.1:<port>/v1/attach`. Over that socket the
  browser is the native `RpcServer` for one RPC, `Inspect`. The gateway is
  the native `RpcClient`.
- The native `RpcServer` accepts sockets only from a `SocketServer`
  (`makeProtocolSocketServer`). The single-socket handler is private. The
  attachment supplies a `SocketServer` whose `run` loop dials instead of
  accepting: one outgoing `Socket.makeWebSocket` at a time, each handed to
  the native handler as one client. When that socket ends, `run` backs off
  and dials again. A reconnect is a new RPC client, so `RpcServer`
  interrupts the old client's handlers when the old socket closes.
- The gateway wraps each accepted Bun `ServerWebSocket` as a
  `Socket.WebSocketLike`, builds `Socket.fromWebSocket`, and builds one
  `RpcClient.make(RootRpcs)` over `RpcClient.makeProtocolSocket` with
  `retryPolicy: Schedule.recurs(0)`. A server-side socket cannot be redialed.
  A reconnect arrives as a new socket and a new incarnation.
- Readers use loopback HTTP with one versioned JSON request and one versioned
  JSON response. An HTTP exchange gives a natural cancellation edge: a reader
  that times out or disconnects aborts the request, Bun aborts
  `request.signal`, the gateway interrupts that read's fiber, and the native
  `RpcClient` sends `Interrupt` to the browser.

### Evidence

All evidence comes from real headless WebKit (`Bun.WebView`), real loopback
sockets, and a production-shaped root (`tests/fixture/app.tsx`: one
`Frame.layer`, the real query cache through `QueryTest.layer`, the browser
`Location`, one routed mount, and a resolver held on a `Deferred`).

- Type compatibility was not the proof. The dialing `SocketServer` passed
  lifetime, request cancellation, disconnect, and reconnect in the browser
  proofs below.
- Two real faults surfaced and are fixed in the proof:
  - A pending read could fail as `RootProtocolError` with a
    `SocketCloseError` when the gateway dropped a root. The RPC client saw the
    socket close before the gateway recorded why. The gateway now completes
    the incarnation's close reason before it closes the socket.
  - `Frame.DiagnosticValue` was typed `Schema.Schema<DiagnosticValue>`, which
    left `unknown` encoding and decoding services on `Frame.Snapshot`. Any
    typed encode (`Schema.encodeSync`, `Rpc.make`, `decodeUnknownExit`) then
    failed to type check or leaked `unknown` into the requirements. It is
    now `Schema.Codec<DiagnosticValue>`. This is a type-only change to a
    published module; root decides whether it ships with a Changeset.
- Native DevTools was not used. Its rc.115 request union is
  `Ping | Span | SpanEvent | MetricsSnapshot`. It has no typed snapshot
  request.

## Lifecycle

Attachment (`src/attach.ts`, browser):

1. The application boundary opts in. The production entry imports no
   inspection module. The development entry calls `attach` only when page
   config names a gateway.
2. `attach` reads the existing `Frame.Service` and captures its construction
   context (`Context.omit(Scope)`), like `ViewTest`. It builds no Frame layer
   and copies no records. Each `Inspect` request takes one fresh sample.
3. `attach` forks one loop in the caller's scope and returns at once. Mount
   never waits for the gateway. The loop's backoff timers use Effect's live
   clock, so an application `TestClock` neither freezes nor advances them.
4. The root ID and name come from the service's own sample on first dial.
5. Closing the root scope interrupts the loop, closes the socket, and ends
   every in-flight handler. No further dials occur.

Gateway (`src/gateway.ts`, Bun):

1. `make` binds `127.0.0.1` on the configured or an ephemeral port in the
   caller's scope.
2. Each accepted root socket becomes one incarnation with its own scope,
   close reason, and `RpcClient`. The registry maps root ID to the live
   incarnation and its metadata only. It keeps no snapshot history.
3. A second socket for the same root ID replaces the first. The first
   incarnation ends; its pending reads fail with its own incarnation number.
4. `terminate` ends an incarnation at once: registry entry, close reason,
   RPC scope, then socket. It does not wait for a busy or dead peer's close
   handshake.
5. Closing the gateway scope terminates every incarnation and stops the
   server.

Reader (`src/client.ts`):

1. `run(argv, environment)` returns `{ exitCode, stdout, stderr }`. It never
   touches the process. `tests/fixture/cli-process.ts` shows the thin process
   wrapper a public executable needs: argv, the token variable, SIGINT, the
   streams, and the exit code.
2. Each command makes one HTTP exchange with a finite deadline.

## Protocol schema (version 1)

Root link, WebSocket `GET /v1/attach?root=<frame root id>&name=<name>`:

- Subprotocols: `effect-frame-inspection.v1` and
  `effect-frame-attach.<attach capability>`. Browsers cannot set handshake
  headers, so the capability travels as a subprotocol, not in the URL.
- Checks in order: loopback `Host`, exact `Origin`, version subprotocol,
  attach capability, root ID pattern `[A-Za-z0-9._:-]{1,128}`, printable name
  of at most 128 characters, and at most 64 roots. A refused upgrade returns
  a JSON error body.
- RPC group `RootRpcs` with one RPC:
  `Inspect { maxBytes: Int } -> Frame.Snapshot | SnapshotTooLarge { bytes, limit }`
  over `RpcSerialization.json`.
- The gateway accepts only `Chunk`, `Exit`, `Defect`, and `Pong` frames from a
  root. A binary frame, non-JSON frame, or other message tag is a protocol
  violation. The gateway drops that root, and its pending reads fail with
  `RootProtocolError`.

Reader API:

- `GET /v1/roots` and `POST /v1/inspect` with
  `authorization: Bearer <read capability>` and
  `effect-frame-inspection-version: 1`.
- Requests with any `Origin` header are refused. Browsers always send one on
  cross-origin requests; the CLI never does.
- `POST /v1/inspect` body:
  `{ "version": 1, "root": "<selector>", "deadlineMillis": 1..30000 }`.
- Selector: exact root ID, or a unique root ID prefix, or an exact root name.
  Several matches return `AmbiguousRoot` with the candidates. No match
  returns `RootNotFound`.
- Responses are one JSON document each:
  - `{ "_tag": "Roots", "version": 1, "roots": [RootInfo] }`
  - `{ "_tag": "Inspection", "version": 1, "root": RootInfo, "snapshot": Frame.Snapshot }`
  - `{ "_tag": "Error", "version": 1, "error": GatewayError }`
- `RootInfo = { id, name, incarnation, attachedAt }`.
- `GatewayError` tags and HTTP status: `UnsupportedProtocolVersion`,
  `MalformedRequest`, `InvalidDeadline` (400); `Unauthorized` (401);
  `ForbiddenOrigin`, `ForbiddenHost` (403); `NotFound`, `RootNotFound` (404);
  `AmbiguousRoot` (409); `SnapshotTooLarge` (413); `RootDisconnected`,
  `RootProtocolError` (502); `TooManyRoots` (503); `DeadlineExceeded` (504).
- Reader-side errors use the same envelope: `GatewayUnreachable`,
  `GatewayTimedOut`, and `MalformedResponse`.

## Proof map

`tests/transport.test.ts`, `tests/protocol.test.ts`, and
`tests/build.test.ts`; 14 tests, run by the package's `test` script.

1. Held query: the CLI reads the same root while its real resolver is held.
   Root ID, mount, route, local actor, query ID, cache ID, key, and `Loading`
   state equal direct `Frame.inspect` reads before and after. The query age
   is strictly between the two direct ages. The resolver started once and
   did not finish. After release, the next read shows `Ready` with
   `"book 7"`.
2. Two tabs: two roots are listed and each selector reaches only its root.
   The shared prefix `frame-root-` returns `AmbiguousRoot` with both
   candidates. After one tab closes, its ID and name return `RootNotFound`,
   and the shared prefix then reaches only the remaining root.
3. Cancellation: the page thread is held so three reads queue. A 300 ms
   deadline returns `DeadlineExceeded` in under 1.4 s. A CLI process killed
   with SIGINT exits 130, and the gateway counts one interrupted read. The
   third read completes after the page resumes. The app stays mounted, the
   resolver is still held, and the gateway ends with zero pending reads.
4. Cleanup: 30 reads and 10 gateway-side drops with reconnects keep the same
   records, one open browser socket, one live gateway incarnation, zero
   pending reads, and the same root scope finalizer count. A read pending on
   a dropped incarnation fails with `RootDisconnected` for that incarnation.
   Root close removes the root, stops dialing, and leaves no open socket.
   Tab close with a read in flight fails that read with `RootDisconnected`.
5. Absent gateway: the development root with a dead gateway port mounts as
   fast as the production root (within 100 ms, under 500 ms). The
   production and disabled development roots create no WebSocket. Backoff
   stays at or below the configured cap, with 2 to 8 dials in 1.2 s. A
   gateway that starts later is found by a correctly configured root. Root
   close ends the loop.
6. Protocol failures: bad reader version header or body version, non-JSON
   and wrong-field bodies, control characters, an over-limit deadline, a
   wrong capability, a browser `Origin`, a rebinding `Host`, and an unknown
   path each return one valid versioned JSON error. Attach refusals cover a
   bad or missing origin, version 2, the read capability used to attach, and
   a bad root ID. Three malformed root frames each fail the pending read
   with `RootProtocolError` and drop that root. A late reply to a timed-out
   request is dropped; the next request settles only with its own reply. A
   real browser on the wrong origin or with the wrong capability never
   attaches, and its app still mounts. A 512-byte limit returns
   `SnapshotTooLarge` and keeps the root attached. Text output labels each
   cut value and points to `--json`; JSON output is complete and one line.
   CLI misuse exits 2, operational failure exits 1, and help exits 0.
7. Build separation: the production bundle has no inspection module, no RPC
   or socket module, and no `WebSocket`. The development bundle has the
   attachment and protocol, and no gateway, reader, Bun, or Node module.

## Limits

- The snapshot is sampled, not atomic, as `Frame.inspect` documents.
- The browser measures the encoded snapshot against `maxBytes` before it
  replies. The gateway also sets the WebSocket `maxPayloadLength` to that
  limit plus 64 KiB. Collection work itself is not bounded; a very large
  root still pays for one full sample before the size check fails.
- The root link has one RPC, `Inspect`. There is no stream, watch, command,
  or evaluation RPC.
- The attach capability is visible to every script in the application
  origin. It is a development capability. It allows only registration; it
  cannot read other roots.
- Root identity comes from one sample on first dial. A public API should
  expose the root ID on `Frame.Service` so attachment needs no sample.
- The gateway has no rate limit and no cap on concurrent pending reads.
- The proof runs WebKit on macOS and the system Chrome elsewhere (CI runs it on Linux Chrome). It skips on a host with neither.
- Commands are `Available`: the text view lists each retained record (kind, lifecycle, attempt, running or idle, command ID), never its payload.

## Recommendation for the public boundary

Keep three pieces with three dependency classes:

- `effect-frame/inspection` (browser-safe subpath of `effect-frame`):
  `Protocol` (schemas, `RootRpcs`, version constants) and `attach`. It
  depends only on `effect` core (`unstable/rpc`, `unstable/socket`) and
  `effect-frame/frame`. The build proof shows it stays out of a production
  entry that does not import it.
- `@effect-frame/inspect` (new package, `bin: effect-frame`): the gateway and
  the reader. It is the only piece that imports Bun. Keeping it out of
  `effect-frame` keeps `platform: neutral` publishing intact and keeps
  server code out of every browser dependency graph.
- EGW opts in from its development entry only. Its production entry imports
  nothing from `effect-frame/inspection`.

Commands for that executable:

```
effect-frame gateway --origin <app origin> [--port <n>] [--state-dir <dir>]
effect-frame roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
effect-frame inspect --url <gateway> --root <id|prefix|name> [--json]
                     [--deadline <ms>] [--token-file <path>] [--max-text <n>]
```

- `gateway` writes the attach and read capabilities to files with mode 0600
  in the state directory and prints the attach URL and the capability file
  paths on stderr. It never prints a capability on stdout or takes one as a
  flag.
- Readers take the capability from `--token-file` or
  `EFFECT_FRAME_INSPECT_TOKEN`.
- Human text is the default. `--json` prints exactly one versioned document
  on stdout, for success and for failure.
- Exit codes: 0 success; 1 operational failure (gateway or root error,
  unreachable gateway, timeout); 2 invalid arguments, missing capability, or
  empty invocation; 130 SIGINT.
- The deadline is always finite: default 5000 ms, maximum 30000 ms.
- Never select a root implicitly when several match.
