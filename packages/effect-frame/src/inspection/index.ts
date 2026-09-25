/**
 * `effect-frame/inspection`: live inspection of a browser Frame root.
 *
 * - `Protocol` is the versioned wire contract: the fixed strings in
 *   `Protocol.wire`, the reader documents, the error union, and the
 *   root-link RPC group (`RootRpcs`, `Inspect`; unstable, built with
 *   `effect/unstable/rpc`).
 * - `attachGateway` connects the current root's `Frame.Service` to a
 *   loopback inspection gateway. The gateway and the reader are the separate
 *   `@effect-frame/inspect` package, which is the only Bun piece.
 *
 * This subpath is browser-safe. It imports `effect` core and
 * `effect-frame/frame` only. Import it from a development entry; a
 * production entry that does not import it carries none of it.
 */
export * as Protocol from "./protocol.js";
export {
  attachGateway,
  defaultOpenTimeout,
  defaultRetry,
  InvalidAttachOptions,
  type AttachOptions,
  type Attachment,
  type AttachStatus,
} from "./attach.js";
