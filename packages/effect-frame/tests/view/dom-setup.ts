import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * One document for every browser test file in this process.
 *
 * happy-dom replaces the platform's web classes with its own. Those cannot
 * reach a loopback socket, and `Bun.serve` rejects a `Response` it did not
 * define. The view tests need happy-dom for the DOM only, so the platform's
 * web classes are captured first and put back afterwards. The streamed
 * document proofs serve and read real HTTP in this same process. The
 * document has an http origin, because an `HttpClient` resolves every
 * request against `location`, and `about:blank` is no base.
 */
const platformWeb = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  URL: globalThis.URL,
  ReadableStream: globalThis.ReadableStream,
  TextDecoder: globalThis.TextDecoder,
  TextEncoder: globalThis.TextEncoder,
};

export const registerDom = (): void => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://app.test/" });
    Object.assign(globalThis, platformWeb);
  }
};
