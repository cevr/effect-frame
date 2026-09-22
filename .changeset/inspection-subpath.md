---
"effect-frame": minor
---

Add the browser-safe `effect-frame/inspection` subpath for live inspection of a Frame root.

- `Protocol`: the versioned (v1) wire contract. It holds the root-link RPC group `RootRpcs` with its one `Inspect` RPC, the reader documents `RootsResponse`, `InspectResponse`, `ErrorResponse`, and `ReaderResponse`, the `GatewayError` union with `statusOf`, `RootInfo`, `RootId`, `InspectRequest`, `SnapshotTooLarge`, and the version, path, header, and limit constants.
- `attach({ url, token })`: connects the current root's `Frame.Service` to a loopback inspection gateway over one browser-originated WebSocket. It returns at once, retries with a bounded backoff, and stops when its scope closes. It fails with `InvalidAttachOptions` for a non-loopback or malformed gateway URL or a malformed token.

The subpath imports only `effect` core and `effect-frame/frame`. Import it from a development entry only; a production entry that does not import it carries no inspection, RPC, or socket code.
