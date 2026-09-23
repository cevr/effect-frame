/**
 * Terminal-safe text. Snapshot strings come from an application page; the
 * text view must never let one of them act on the reader's terminal.
 */

/**
 * C0 controls, DEL, C1 controls, and the bidirectional embedding, override,
 * and isolate controls.
 */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Show every unsafe code point as `\u{..}`; every other one stays as is. */
export const escapeText = (value: string): string =>
  value.replace(UNSAFE, (unit) => `\\u{${unit.charCodeAt(0).toString(16)}}`);
