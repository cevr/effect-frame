import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * One document for every browser test file in this process.
 *
 * happy-dom replaces the platform's web classes with its own, and the
 * platform's file system refuses happy-dom's `AbortSignal`. The router tests
 * need happy-dom for the DOM only, and the prerender proofs write and serve
 * real files in this same process, so the platform's web classes are
 * captured first and put back afterwards, as `tests/view/dom-setup.ts` does.
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
