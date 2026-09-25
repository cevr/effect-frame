# Live inspection gateway

Status: public boundary for #58. The browser half ships as the
`effect-frame/inspection` subpath of `effect-frame` (minor Changeset). The
gateway and the reader ship as the `effect-frame` executable of the new
workspace package `packages/inspect` (`@effect-frame/inspect`), which stays
`private` until its first npm publish. The private proof workspace
`921638a:tooling/inspection-gateway` is retired. "Public boundary" below lists what
is public, what stays private, and the choices made while promoting it.

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
sockets, and a production-shaped root (`packages/inspect/tests/fixture/app.tsx`: one
`Frame.layer`, the real query cache over a local
`ActorHost.layer`, the browser
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

Attachment (`packages/effect-frame/src/inspection/attach.ts`, browser):

1. The application boundary opts in. The production entry imports no
   inspection module. The development entry calls `attachGateway` only when
   page config names a gateway.
2. `attachGateway` validates its options and fails with
   `InvalidAttachOptions` before any dial: a non-loopback or malformed URL
   (only `127.0.0.1` and `localhost`), or a malformed token. The retry
   `Schedule` and the `openTimeout` are required values;
   `defaultRetry` and `defaultOpenTimeout` name the defaults. It reads the existing `Frame.Service` and captures its construction
   context (`Context.omit(Scope)`), like `ViewTest`. It builds no Frame layer
   and copies no records. Each `Inspect` request takes one fresh sample.
3. The root ID and name come from one sample of the service at attach, before
   any dial. An ID that is not a `RootId`, or a name with control characters
   (`RootName`), fails with `InvalidAttachOptions`, so the loop never retries
   a registration the gateway will always refuse.
4. `attachGateway` forks one loop in the caller's scope and returns at once
   with `{ status }`, a `Stream` over a `SubscriptionRef` of `AttachStatus`.
   Mount never waits for the gateway, and the loop never waits for a status
   reader. The loop's backoff timers use Effect's live clock, so an
   application `TestClock` neither freezes nor advances them. Each redial
   waits the next delay of the `retry` schedule (`defaultRetry` doubles from
   250 ms up to 5 s). Reset rule: the schedule starts over only after a
   connection stayed open for at least one second; a gateway that drops the
   socket at once still sees a doubling delay. When the schedule ends, the
   loop stops dialing and reports `Stopped`.
5. Closing the root scope interrupts the loop, closes the socket, and ends
   every in-flight handler. No further dials occur.

Gateway (`packages/inspect/src/gateway.ts`, Bun):

1. `make` binds `127.0.0.1` on the configured or an ephemeral port in the
   caller's scope. A failed bind is a typed `GatewayListenError`.
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

Reader (`packages/inspect/src/reader.ts`) and executable
(`packages/inspect/src/cli.ts`, `packages/inspect/src/bin.ts`):

1. `Reader.run(argv, environment)` returns `{ exitCode, stdout, stderr }`.
   `Cli.main(io)` dispatches `gateway`, `roots`, and `inspect` and returns
   the exit code. Neither touches the process. `bin.ts` is the only process
   boundary: argv, the token variable, `HOME`, `XDG_STATE_HOME`, the PID,
   SIGINT, SIGTERM, and SIGHUP, the streams, and the exit code.
2. Each reader command makes one HTTP exchange with a finite deadline.

## Protocol schema (version 1)

Root link, WebSocket `GET /v1/attach?root=<frame root id>&name=<name>`:

- Subprotocols: `effect-frame-inspection.v1` and
  `effect-frame-attach.<attach capability>`. Browsers cannot set handshake
  headers, so the capability travels as a subprotocol, not in the URL.
- Checks in order: loopback `Host`, exact `Origin`, version subprotocol,
  attach capability, root ID (`RootId`, `[A-Za-z0-9._:-]{1,128}`), root
  name (`RootName`: at most 128 characters, no C0, DEL, or C1 control), and
  at most 64 roots. Only `127.0.0.1` and `localhost` are loopback hosts. A refused upgrade returns
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
- `POST /v1/inspect` body, decoded with `InspectRequest`:
  `{ "version": 1, "root": "<selector>", "deadlineMillis": 1..30000 }`. A
  body over 4096 bytes is refused as it streams. A decode failure maps to
  `UnsupportedProtocolVersion` (another `version`), `InvalidDeadline` (a
  finite number outside `DeadlineMillis`), or `MalformedRequest`.
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
  `GatewayTimedOut`, `MalformedResponse`, `InvalidArguments`,
  `MissingCapability`, and `Interrupted`. `Reader.Document` is the schema of
  the one document `--json` prints.

## Proof map

Items 1-7 are `packages/inspect/tests/transport.test.ts`,
`packages/inspect/tests/protocol.test.ts`, and
`packages/inspect/tests/build.test.ts`. Item 8 is
`packages/inspect/tests/cli.test.ts`. Item 9 is
`packages/effect-frame/tests/inspection/`. Item 10 is
`packages/inspect/tests/reader.test.ts` and
`packages/inspect/tests/gateway.test.ts`. Each package's `test` script runs
them (26 tests in `packages/inspect`, 13 in `effect-frame`'s
`test:inspection`).

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
   production and disabled development roots create no WebSocket. The
   recorded retry delays equal `min(400, 50 * 2^n)`: each delay doubles up to
   the cap. A root that the gateway drops at once, three times, waits 50,
   100, then 200 ms: a short connection does not reset the delay. A
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
   CLI misuse exits 2, operational failure exits 1, and help exits 0. The
   SIGINT case runs the real `src/bin.ts` and ends with exactly one
   `Interrupted` document on stdout.
7. Build separation: the production bundle has no `effect-frame/inspection`
   module, no RPC or socket module, and no `WebSocket`. The development bundle
   has the attachment and protocol from `effect-frame/src/inspection`, and no
   gateway, reader, Bun, or Node module.
8. Executable: real child processes of `src/bin.ts`. An empty invocation
   exits 2; `--help`, `gateway --help`, and `inspect --help` exit 0. Misuse
   with `--json` (unknown command, a `--token` flag, a deadline over 30000, a
   remote URL) exits 2 with one `InvalidArguments` document. An unreachable
   gateway exits 1 with one `GatewayUnreachable` document. A running
   `gateway` writes `attach-token` and `read-token` with mode 0600, prints
   their paths but not their contents, and prints nothing on stdout. Readers
   succeed with `--token-file` and with `EFFECT_FRAME_INSPECT_TOKEN`; an
   unknown root exits 1 (`RootNotFound`), no capability exits 2
   (`MissingCapability`), the attach capability exits 1 (`Unauthorized`), and
   a second gateway on the same port exits 1. A second gateway on the SAME
   state directory exits 1 and names the live PID; the first gateway's files
   stay intact. A stale lock with a dead PID is taken over. SIGINT, SIGTERM,
   and SIGHUP stop the gateway with exit 130, 143, and 129 and remove both
   files and the lock. The state directory has mode 0700. A symlink planted
   at a capability path is replaced, and its target keeps its content. A
   directory that another user owns (`/usr`, when not root) exits 1. A
   missing `HOME` and a relative `XDG_STATE_HOME` exit 2. Every `--json`
   stdout decodes as exactly one `Reader.Document` line.
9. Public subpath: `Protocol` documents round-trip through JSON with a real
   Frame snapshot; another version fails to decode; every `GatewayError` maps
   to its HTTP status; the `Inspect` RPC exit codec carries a snapshot and
   `SnapshotTooLarge`. `Protocol.wire` is one camelCase object and no
   `Protocol` key is a SCREAMING constant. The schemas accept a deadline of 1
   and 30000 and refuse 0, 30001, and 1.5; they accept a root selector of 1
   to 256 characters and refuse BEL, CSI, DEL, and C1 characters.
   `attachGateway` refuses non-`ws:`, non-loopback (including `[::1]`),
   portless, and unparsable URLs, a malformed token, and a root name with
   control characters (with zero dials). A retry schedule that ends after
   two redials leaves three dials and a `Stopped` status. Against a peer that drops each socket on open, the delays are
   20, 40, 80, 160, 160, 160 ms. Against a raw loopback peer it
   dials `/v1/attach` with its root ID, name, and both subprotocols, answers
   `Inspect` and `SnapshotTooLarge`, and closes the socket when its scope
   closes. The subpath bundles for a browser with no Bun or Node input.
10. Hostile snapshot and body: a gateway returns a snapshot with OSC, CSI,
    BEL, C1 CSI, bidi controls, and DEL in a route name, a URL, and a command
    ID. Text output contains none of those code points and shows their
    `\u{..}` forms; `--json` keeps the raw strings. An endless chunked
    request body gets `MalformedRequest` ("request body too large") after
    less than 64 KiB is sent. The gateway, the reader and `DeadlineMillis`
    all read the bound from `Protocol.maxDeadlineMillis`.

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
- Root identity comes from one sample at attach. A public API should expose
  the root ID on `Frame.Service` so attachment needs no sample.
- The gateway has no rate limit and no cap on concurrent pending reads.
- The proof runs WebKit on macOS and the system Chrome elsewhere (CI runs it on Linux Chrome). It skips on a host with neither.
- Commands are `Available`: the text view lists each retained record (kind, lifecycle, attempt, running or idle, command ID), never its payload.

## Public boundary

This section was the recommendation; it is now what ships. Three pieces with
three dependency classes:

- `effect-frame/inspection` (browser-safe subpath of `effect-frame`,
  source `packages/effect-frame/src/inspection/`). Exports: `Protocol` (a
  namespace: `wire` and its type `Wire`, `SnapshotTooLarge`, `Inspect`,
  `RootRpcs`, `RootId`, `RootName`, `RootSelector`, `DeadlineMillis`,
  `maxDeadlineMillis`, `loopbackHosts`,
  `RootInfo`, `InspectRequest`, `GatewayError`, `RootsResponse`,
  `InspectResponse`, `ErrorResponse`, `ReaderResponse`), `attachGateway`,
  `defaultRetry`, `defaultOpenTimeout`, `InvalidAttachOptions`, and the types
  `AttachOptions`, `Attachment` and `AttachStatus`.
  `Protocol.wire` is the one object of fixed wire strings (`version`,
  `subprotocol`, `attachTokenPrefix`, `versionHeader`, `attachPath`,
  `rootsPath`, `inspectPath`). Every request bound lives in a schema:
  `DeadlineMillis` is an integer from 1 to 30000, `RootSelector` is 1 to 256
  characters with no C0, DEL, or C1 control, and `RootName` is at most 128
  such characters. The gateway decodes with these schemas and repeats no
  check. `RootRpcs` and `Inspect` are marked unstable in their TSDoc and in
  the Changeset: they are built on `effect/unstable/rpc`, and the gateway has
  no other source for them.
  It depends only on `effect` core (`unstable/rpc`, `unstable/socket`,
  `unstable/net`) and `effect-frame/frame`. The build proof shows it stays out
  of a production entry that does not import it. The directory also holds
  `registry.ts`, the internal record registry that the router and actors
  import; `index.ts` does not import it, and the subpath does not export it.
- `@effect-frame/inspect` (`packages/inspect`, `bin: effect-frame`, built by
  tsdown to `dist/bin.js` with a `bun` shebang): the gateway and the reader.
  It is the only piece that imports Bun. Keeping it out of `effect-frame`
  keeps `platform: neutral` publishing intact and keeps server code out of
  every browser dependency graph. It exports no library entry; the gateway
  `make` and `Reader.run` stay internal until a consumer needs them.
- EGW opts in from its development entry only. Its production entry imports
  nothing from `effect-frame/inspection`.

Commands for that executable:

```
effect-frame gateway --origin <app origin> [--port <n>] [--state-dir <dir>]
effect-frame roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
effect-frame inspect --url <gateway> --root <id|prefix|name> [--json]
                     [--deadline <ms>] [--token-file <path>] [--max-text <n>]
```

- `gateway` takes an exclusive `gateway.lock` in the state directory, then
  writes the attach and read capabilities to files with mode 0600 there, and prints the attach URL and the capability file
  paths on stderr. It never prints a capability on stdout or takes one as a
  flag.
- Readers take the capability from `--token-file` or
  `EFFECT_FRAME_INSPECT_TOKEN`.
- Human text is the default. `--json` prints exactly one versioned document
  on stdout, for success and for failure.
- Exit codes: 0 success; 1 operational failure (gateway or root error,
  unreachable gateway, timeout); 2 invalid arguments, missing capability, or
  empty invocation; 130 SIGINT; 143 SIGTERM; 129 SIGHUP. The gateway treats
  all three signals alike: it removes its files, then exits with the
  signal's code.
- The deadline is always finite: default 5000 ms, maximum 30000 ms.
- Never select a root implicitly when several match.

### What stays private, and why

- `@effect-frame/inspect` is `"private": true` with no Changeset. The release
  workflow publishes only through npm OIDC, and `NPM_TOKEN` is empty, so the
  first publish needs the owner to create the npm package and add a Trusted
  Publisher. Its README says so.
- The reader limits (`DEFAULT_DEADLINE_MILLIS` and
  `MAX_REQUEST_BYTES`, in `packages/inspect/src/limits.ts`), `statusOf`, text
  escaping (`packages/inspect/src/text.ts`), and reader-side errors
  (`Reader.ClientError`, `Reader.Document`) live in `packages/inspect`. The
  deadline bound and the loopback hosts are `Protocol` constants. They
  describe the executable's output, not the wire between browser and gateway.
- The internal record registry `packages/effect-frame/src/inspection/registry.ts`
  stays internal; only `src/inspection/index.ts` is exported.

### Choices made while promoting

- The repository has no Effect CLI module in use; `tooling/dom-bench` parses
  argv by hand. The executable follows that idiom with a small hand parser.
- `gateway --port` defaults to 4318, the port every example uses, so a
  development entry can use a fixed attach URL; `--port 0` asks for an
  ephemeral port.
- `gateway --state-dir` defaults to `$XDG_STATE_HOME/effect-frame/inspect`,
  else `$HOME/.local/state/effect-frame/inspect`. A relative
  `XDG_STATE_HOME` or a missing or relative `HOME` exits 2. The gateway
  creates the directory with mode 0700, refuses a path that is not a
  directory or that another user owns (exit 1), and `chmod`s it to 0700.
- One gateway owns a state directory. It creates `gateway.lock` exclusively
  with its PID. If the lock holds a live PID (`kill(pid, 0)` succeeds or
  fails with `EPERM`), the second gateway exits 1 and names that PID; the
  first gateway's files stay intact. If the PID is dead, the new gateway
  removes the stale lock and takes it. On stop it removes the lock only if
  the lock still holds its own PID.
- Each capability file is removed and then created exclusively with mode
  0600 and `chmod`ed, so a planted symlink or a wider mode is never reused.
  Both files are removed when the gateway stops: the capabilities die with
  it.
- The gateway reads a request body chunk by chunk and refuses it with
  `MalformedRequest` ("request body too large") once it passes 4096 bytes,
  so a chunked body without `Content-Length` is bounded as it arrives.
- Text output escapes every snapshot string: C0 controls, DEL, C1 controls,
  and the bidirectional controls U+202A-U+202E and U+2066-U+2069 print as
  `\u{..}`. `--json` keeps the raw strings; JSON encoding escapes them.
- `--origin` must be a bare `http(s)` origin; a trailing slash is accepted
  and normalized to the browser's `Origin` value.
- `--json` prints exactly one document for every reader exit code, including
  invalid arguments (`InvalidArguments`), a missing capability
  (`MissingCapability`), and a signal (`Interrupted`, with its `signal`). Help is not a document;
  it prints text and exits 0.
- `gateway` has no `--json`. It prints nothing on stdout; its URLs and file
  paths go to stderr.
