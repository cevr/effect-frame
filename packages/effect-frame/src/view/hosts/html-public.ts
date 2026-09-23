/**
 * The public `Html` namespace. It lists its exports, so a helper that the
 * host module exports for the router's server document (`Drawing`,
 * `streamDrawing`, `awaitAllDrawing`, `renderSeeded`) never becomes public
 * by accident. The implementation is `html.ts`.
 */
export {
  element,
  escapeAttribute,
  escapeJsonScript,
  escapeText,
  host,
  jsonScript,
  RecordsUnsettled,
  renderAwaitAll,
  renderToStream,
  renderToString,
  serialize,
  serializeChildren,
  streamRecord,
  textSeparator,
} from "./html.js";
export type { Document, HtmlComment, HtmlElement, HtmlNode, HtmlText } from "./html.js";
