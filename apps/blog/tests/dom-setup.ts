import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * One document for every browser test in this process.
 *
 * happy-dom replaces the platform's `fetch`, `Request`, and `Response` with
 * its own. Those cannot reach a loopback socket, and `Bun.serve` rejects a
 * `Response` it did not define. The test needs happy-dom for the DOM only,
 * so the platform's web classes are captured first and put back afterwards.
 */
export const platformFetch: typeof globalThis.fetch = globalThis.fetch;

const platformWeb = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  URL: globalThis.URL,
  ReadableStream: globalThis.ReadableStream,
};

export const registerDom = (): void => {
  if (GlobalRegistrator.isRegistered) {
    return;
  }
  // An http origin: an `HttpClient` resolves every request against `location`.
  GlobalRegistrator.register({ url: "http://blog.test/" });
  Object.assign(globalThis, platformWeb);
};
