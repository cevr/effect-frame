/**
 * `effect-frame/inspection`: live inspection of a browser Frame root.
 *
 * - `Protocol` is the versioned wire contract: the root-link RPC group, the
 *   reader API documents, the error union, and the version constants.
 * - `attach` connects the current root's `Frame.Service` to a loopback
 *   inspection gateway. The gateway and the reader are the separate
 *   `@effect-frame/inspect` package, which is the only Bun piece.
 *
 * This subpath is browser-safe. It imports `effect` core and
 * `effect-frame/frame` only. Import it from a development entry; a
 * production entry that does not import it carries none of it.
 */
export * as Protocol from "./protocol.js";
export { attach, InvalidAttachOptions, type AttachOptions, type AttachStatus } from "./attach.js";
