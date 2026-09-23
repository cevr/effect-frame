---
"effect-frame": minor
---

Add the browser-safe `effect-frame/inspection` subpath for live inspection of a Frame root.

- `Protocol`: the versioned (v1) wire contract.
  - `Protocol.wire` holds the fixed strings: `version`, `subprotocol`, `attachTokenPrefix`, `versionHeader`, `attachPath`, `rootsPath`, and `inspectPath`.
  - The schemas hold every bound: `InspectRequest` (with `RootSelector`, 1 to 256 characters with no control characters, and `DeadlineMillis`, an integer from 1 to 30000), `RootInfo` (with `RootId` and `RootName`), `SnapshotTooLarge`, `GatewayError`, and the reader documents `RootsResponse`, `InspectResponse`, `ErrorResponse`, and `ReaderResponse`.
  - `RootRpcs` and its one `Inspect` RPC are **unstable**: they are built with `effect/unstable/rpc`, so their types follow that module and can change with an Effect release. The wire format is versioned by `Protocol.wire.version`.
- `attachGateway({ url, token })`: connects the current root's `Frame.Service` to a loopback inspection gateway (`127.0.0.1` or `localhost`) over one browser-originated WebSocket. It returns at once, retries with a delay that doubles from `initialRetryMillis` to `maxRetryMillis`, resets the delay only after a connection stayed open for one second, and stops when its scope closes. A throwing `onStatus` observer never stops the loop. It fails with `InvalidAttachOptions` for a malformed or non-loopback gateway URL, a malformed token, a non-finite or non-positive retry or open timeout, a `maxRetryMillis` below `initialRetryMillis`, or a root name with control characters.

The subpath imports only `effect` core and `effect-frame/frame`. Import it from a development entry only; a production entry that does not import it carries no inspection, RPC, or socket code.
