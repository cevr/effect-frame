/* oxlint-disable effect/noAsyncFunction, effect/noGlobals -- this proof streams a raw HTTP body into the real gateway. */
/**
 * The gateway bounds a reader request body as the bytes arrive. A chunked
 * body with no length and no end is refused once it crosses the limit.
 */
import { describe, expect, it } from "bun:test";
import { Protocol } from "effect-frame/inspection";
import * as H from "./harness.js";

describe("gateway request bodies", () => {
  it("refuses an endless chunked body as soon as it crosses the limit", async () => {
    const running = await H.startGateway({ allowedOrigin: "http://127.0.0.1:9" });
    let sent = 0;
    // One kilobyte per pull, and the stream never closes.
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (sent < 64 * 1024) {
          sent += 1024;
          controller.enqueue(new Uint8Array(1024).fill(0x20));
        }
      },
    });
    const response = await fetch(new URL(Protocol.wire.inspectPath, running.gateway.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${running.readToken}`,
        [Protocol.wire.versionHeader]: "1",
        "content-type": "application/json",
      },
      body,
    }).finally(() => running.close());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      _tag: "Error",
      version: 1,
      error: { _tag: "MalformedRequest", detail: "request body too large" },
    });
    // The gateway stopped reading near the 4 KiB limit, not at the end.
    expect(sent).toBeLessThan(64 * 1024);
  }, 10_000);
});
