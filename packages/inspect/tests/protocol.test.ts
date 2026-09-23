/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewPromise, effect/noNullish, effect/noTernary, effect/noThrowStatement, effect/noNewError, effect/noTryCatch, no-await-in-loop -- this proof drives raw sockets, raw HTTP, and a real WebKit page against the gateway boundary. */
/**
 * Item 6 of the scope draft: explicit failures at every protocol boundary.
 * Reader cases use raw HTTP and the CLI-shaped client. Root-link cases a
 * real attachment never produces (malformed frames, late replies) use a raw
 * Bun WebSocket that passes the same origin and capability checks. Wrong
 * origin, wrong capability, and oversized snapshots use the real browser.
 */
import { describe, expect, it } from "bun:test";
import * as Frame from "effect-frame/frame";
import { Effect, Exit, Schema } from "effect";
import { Rpc, RpcSerialization } from "effect/unstable/rpc";
import { Protocol } from "effect-frame/inspection";
import * as H from "./harness.js";

const ORIGIN = "http://127.0.0.1:9";

const gateway = (options: { readonly maxSnapshotBytes?: number } = {}) =>
  H.startGateway({ allowedOrigin: ORIGIN, ...options });

const decodeReader = Schema.decodeUnknownExit(Protocol.ReaderResponse);

/** Every reader reply is one valid, versioned JSON document. */
const readJson = async (response: Response): Promise<Protocol.ErrorResponse["error"]> => {
  const body: unknown = await response.json();
  const decoded = decodeReader(body);
  expect(Exit.isSuccess(decoded)).toBe(true);
  if (Exit.isFailure(decoded) || decoded.value._tag !== "Error") {
    throw new Error(`expected an error document: ${JSON.stringify(body)}`);
  }
  expect(decoded.value.version).toBe(1);
  return decoded.value.error;
};

const readerHeaders = (token: string, version = "1") => ({
  authorization: `Bearer ${token}`,
  [Protocol.wire.versionHeader]: version,
  "content-type": "application/json",
});

const post = (base: string, token: string, body: string, version = "1") =>
  fetch(new URL(Protocol.wire.inspectPath, base), {
    method: "POST",
    headers: readerHeaders(token, version),
    body,
  });

/** A peer that passes the attach checks and speaks raw frames. */
const rawRoot = async (running: H.RunningGateway, rootId: string) => {
  const url = new URL(Protocol.wire.attachPath, running.gateway.attachUrl);
  url.searchParams.set("root", rootId);
  url.searchParams.set("name", "raw");
  const frames: Array<string> = [];
  const socket = new WebSocket(url.href, {
    // @ts-expect-error The DOM lib hides Bun's constructor overload with handshake headers.
    headers: { origin: ORIGIN },
    protocols: [
      Protocol.wire.subprotocol,
      `${Protocol.wire.attachTokenPrefix}${running.attachToken}`,
    ],
  });
  socket.addEventListener("message", (event) => {
    frames.push(String(event.data));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("raw root did not open")), {
      once: true,
    });
  });
  await H.waitUntil(async () => (await H.stats(running)).roots >= 1, "raw root attached");
  // Request ids are echoed exactly as sent; the JSON codec keeps numbers.
  const nextRequest = async (): Promise<{ readonly id: string | number }> => {
    await H.waitUntil(
      async () => frames.some((frame) => frame.includes('"Request"')),
      "request frame",
    );
    const index = frames.findIndex((frame) => frame.includes('"Request"'));
    const [frame] = frames.splice(index, 1);
    const parsed: unknown = JSON.parse(frame ?? "{}");
    const message = Array.isArray(parsed) ? parsed[0] : parsed;
    return { id: message.id };
  };
  return { socket, nextRequest };
};

/** A real snapshot from a real Frame root in this process. */
const realSnapshot = (name: string) =>
  // This test process is the application entry point for this root.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.runPromise(Effect.scoped(Frame.inspect.pipe(Effect.provide(Frame.layer({ name })))));

const encodeExit = Schema.encodeSync(
  RpcSerialization.json.codecFor(Rpc.exitSchema(Protocol.Inspect)),
);

const exitFrame = (requestId: string | number, snapshot: Frame.Snapshot): string =>
  JSON.stringify({ _tag: "Exit", requestId, exit: encodeExit(Exit.succeed(snapshot)) });

const inspectRaw = (running: H.RunningGateway, root: string, deadline: string) =>
  H.cliJson<Protocol.InspectResponse | Protocol.ErrorResponse>(
    ["inspect", "--url", running.gateway.url, "--root", root, "--deadline", deadline],
    running.readToken,
  );

describe("inspection protocol failures are explicit", () => {
  it("rejects reader requests with bad versions, bodies, capabilities, origins, and hosts", async () => {
    const running = await gateway();
    const base = running.gateway.url;
    const token = running.readToken;
    try {
      const oldHeader = await fetch(new URL(Protocol.wire.rootsPath, base), {
        headers: readerHeaders(token, "2"),
      });
      expect(oldHeader.status).toBe(400);
      expect(await readJson(oldHeader)).toEqual({
        _tag: "UnsupportedProtocolVersion",
        received: "2",
        supported: [1],
      });

      const oldBody = await post(
        base,
        token,
        JSON.stringify({ version: 2, root: "x", deadlineMillis: 10 }),
      );
      expect(await readJson(oldBody)).toMatchObject({
        _tag: "UnsupportedProtocolVersion",
        received: "2",
      });

      const notJson = await post(base, token, "{inspect");
      expect(notJson.status).toBe(400);
      expect(await readJson(notJson)).toEqual({
        _tag: "MalformedRequest",
        detail: "body is not JSON",
      });

      const wrongFields = await post(base, token, JSON.stringify({ version: 1, root: 7 }));
      expect((await readJson(wrongFields))._tag).toBe("MalformedRequest");

      const control = await post(
        base,
        token,
        JSON.stringify({ version: 1, root: "a\u0007b", deadlineMillis: 10 }),
      );
      expect((await readJson(control))._tag).toBe("MalformedRequest");

      const deadline = await post(
        base,
        token,
        JSON.stringify({ version: 1, root: "x", deadlineMillis: 999_999 }),
      );
      expect(await readJson(deadline)).toEqual({
        _tag: "InvalidDeadline",
        deadlineMillis: 999_999,
        maximum: 30_000,
      });

      const wrongToken = await fetch(new URL(Protocol.wire.rootsPath, base), {
        headers: readerHeaders(running.attachToken),
      });
      expect(wrongToken.status).toBe(401);
      expect(await readJson(wrongToken)).toEqual({ _tag: "Unauthorized" });

      const browserOrigin = await fetch(new URL(Protocol.wire.rootsPath, base), {
        headers: { ...readerHeaders(token), origin: ORIGIN },
      });
      expect(browserOrigin.status).toBe(403);
      expect(await readJson(browserOrigin)).toEqual({ _tag: "ForbiddenOrigin", origin: ORIGIN });

      const rebinding = await fetch(new URL(Protocol.wire.rootsPath, base), {
        headers: { ...readerHeaders(token), host: "attacker.test" },
      });
      expect(rebinding.status).toBe(403);
      expect((await readJson(rebinding))._tag).toBe("ForbiddenHost");

      const unknownPath = await fetch(new URL("/v1/eval", base), { headers: readerHeaders(token) });
      expect(await readJson(unknownPath)).toEqual({ _tag: "NotFound", path: "/v1/eval" });

      // The CLI keeps stdout one valid JSON document on failure.
      const cliWrong = await H.cliJson<Protocol.ErrorResponse>(
        ["roots", "--url", base],
        running.attachToken,
      );
      expect(cliWrong.result.exitCode).toBe(1);
      expect(cliWrong.body).toEqual({ _tag: "Error", version: 1, error: { _tag: "Unauthorized" } });
    } finally {
      await running.close();
    }
  }, 20_000);

  it("rejects root attachments with a bad origin, version, capability, or identity", async () => {
    const running = await gateway();
    const attach = (headers: Record<string, string>, query = "?root=frame-root-a") =>
      fetch(`${running.gateway.url}${Protocol.wire.attachPath}${query}`, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      });
    const good = {
      origin: ORIGIN,
      "sec-websocket-protocol": `${Protocol.wire.subprotocol}, ${Protocol.wire.attachTokenPrefix}${running.attachToken}`,
    };
    try {
      const evil = await attach({ ...good, origin: "http://evil.test" });
      expect(evil.status).toBe(403);
      expect(await readJson(evil)).toEqual({ _tag: "ForbiddenOrigin", origin: "http://evil.test" });

      const noOrigin = await attach({ "sec-websocket-protocol": good["sec-websocket-protocol"] });
      expect((await readJson(noOrigin))._tag).toBe("ForbiddenOrigin");

      const v2 = await attach({
        ...good,
        "sec-websocket-protocol": `effect-frame-inspection.v2, ${Protocol.wire.attachTokenPrefix}${running.attachToken}`,
      });
      expect(await readJson(v2)).toEqual({
        _tag: "UnsupportedProtocolVersion",
        received: "effect-frame-inspection.v2",
        supported: [1],
      });

      const readTokenUsedToAttach = await attach({
        ...good,
        "sec-websocket-protocol": `${Protocol.wire.subprotocol}, ${Protocol.wire.attachTokenPrefix}${running.readToken}`,
      });
      expect(await readJson(readTokenUsedToAttach)).toEqual({ _tag: "Unauthorized" });

      const badId = await attach(good, "?root=not%20a%20root%3F");
      expect((await readJson(badId))._tag).toBe("MalformedRequest");
      expect((await H.stats(running)).roots).toBe(0);
    } finally {
      await running.close();
    }
  }, 20_000);

  it("fails a read on malformed root frames and drops the offending root", async () => {
    const running = await gateway();
    try {
      for (const garbage of ["not json", '{"_tag":"Request","id":"1"}', "[1,2,3]"]) {
        const root = await rawRoot(running, "frame-root-raw");
        const reply = inspectRaw(running, "frame-root-raw", "5000");
        await root.nextRequest();
        root.socket.send(garbage);
        const { result, body } = await reply;
        expect(result.exitCode).toBe(1);
        const error = body._tag === "Error" ? body.error : undefined;
        expect(error?._tag).toBe("RootProtocolError");
        await H.waitUntil(async () => (await H.stats(running)).roots === 0, "violator dropped");
        root.socket.close();
      }
      const stats = await H.stats(running);
      expect(stats.protocolViolations).toBe(3);
      expect(stats.pendingReads).toBe(0);
    } finally {
      await running.close();
    }
  }, 20_000);

  it("never settles a read with a late reply to an earlier request", async () => {
    const running = await gateway();
    try {
      const root = await rawRoot(running, "frame-root-late");
      const late = await realSnapshot("late");
      const fresh = await realSnapshot("fresh");

      const first = inspectRaw(running, "frame-root-late", "200");
      const firstRequest = await root.nextRequest();
      const firstReply = await first;
      expect(firstReply.result.exitCode).toBe(1);
      expect(firstReply.body).toMatchObject({
        error: { _tag: "DeadlineExceeded", deadlineMillis: 200 },
      });

      const second = inspectRaw(running, "frame-root-late", "5000");
      const secondRequest = await root.nextRequest();
      expect(secondRequest.id).not.toBe(firstRequest.id);
      // The late reply to the first request arrives first. It is dropped.
      root.socket.send(exitFrame(firstRequest.id, late));
      await Bun.sleep(100);
      root.socket.send(exitFrame(secondRequest.id, fresh));
      const secondReply = await second;
      expect(secondReply.body).toMatchObject({ _tag: "Inspection" });
      expect(secondReply.result.exitCode).toBe(0);
      const snapshot =
        secondReply.body._tag === "Inspection" ? secondReply.body.snapshot : undefined;
      expect(snapshot?.root.name).toBe("fresh");
      expect(await H.stats(running)).toMatchObject({ roots: 1, pendingReads: 0 });
      root.socket.close();
    } finally {
      await running.close();
    }
  }, 20_000);

  it.skipIf(!H.hasBrowser)(
    "refuses a real browser on the wrong origin or capability and reports oversized snapshots",
    async () => {
      const devBundle = await H.bundle("main.dev.tsx");
      const page = H.servePage(devBundle.text);
      const other = H.servePage(devBundle.text);
      const running = await H.startGateway({ allowedOrigin: page.origin, maxSnapshotBytes: 512 });
      const views: Array<Bun.WebView> = [];
      try {
        const config = (name: string, token: string) => ({
          name,
          gateway: { url: running.gateway.attachUrl, token },
        });
        views.push(
          await H.openView(other.url("/books/7", config("wrong-origin", running.attachToken))),
        );
        views.push(
          await H.openView(page.url("/books/7", config("wrong-token", running.readToken))),
        );
        for (const view of views) {
          await H.waitFor(view, "window.__fixture && window.__fixture.mountedAt > 0", "mount");
          await H.waitFor(
            view,
            "window.__fixture.status.filter((s) => s._tag === 'Disconnected').length >= 2",
            "refused dials",
          );
          expect(
            await view.evaluate<unknown>(
              "window.__fixture.status.some((s) => s._tag === 'Connected')",
            ),
          ).toBe(false);
        }
        expect((await H.stats(running)).roots).toBe(0);

        const good = await H.openView(page.url("/books/7", config("large", running.attachToken)));
        views.push(good);
        await H.waitUntil(async () => (await H.stats(running)).roots === 1, "attached");
        const reply = await H.cliJson<Protocol.ErrorResponse>(
          ["inspect", "--url", running.gateway.url, "--root", "large"],
          running.readToken,
        );
        expect(reply.result.exitCode).toBe(1);
        expect(reply.body.error._tag).toBe("SnapshotTooLarge");
        if (reply.body.error._tag === "SnapshotTooLarge") {
          expect(reply.body.error.limit).toBe(512);
          expect(reply.body.error.bytes).toBeGreaterThan(512);
        }
        // The root stays attached; the limit fails one read, not the link.
        expect((await H.stats(running)).roots).toBe(1);
      } finally {
        for (const view of views) view.close();
        await running.close();
        page.stop();
        other.stop();
      }
    },
    30_000,
  );

  it.skipIf(!H.hasBrowser)(
    "labels truncated text and keeps JSON complete",
    async () => {
      const devBundle = await H.bundle("main.dev.tsx");
      const page = H.servePage(devBundle.text);
      const running = await H.startGateway({ allowedOrigin: page.origin });
      const view = await H.openView(
        page.url("/books/a-very-long-book-identifier-for-truncation", {
          name: "text",
          gateway: { url: running.gateway.attachUrl, token: running.attachToken },
        }),
      );
      try {
        await H.waitUntil(async () => (await H.stats(running)).roots === 1, "attached");
        const base = ["inspect", "--url", running.gateway.url, "--root", "text"];
        const text = await H.cli([...base, "--max-text", "12"], running.readToken);
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain("[truncated: 12 of");
        expect(text.stdout).toContain("--json returns the complete snapshot");
        const json = await H.cliJson<Protocol.InspectResponse>(base, running.readToken);
        expect(json.body.snapshot.queries[0]?.key).toContain(
          "a-very-long-book-identifier-for-truncation",
        );
        expect(json.result.stdout.trim().split("\n")).toHaveLength(1);
      } finally {
        view.close();
        await running.close();
        page.stop();
      }
    },
    30_000,
  );

  it("maps CLI misuse to exit 2 and operational failure to exit 1", async () => {
    const token = "t".repeat(64);
    const misuse: ReadonlyArray<ReadonlyArray<string>> = [
      [],
      ["watch", "--url", "http://127.0.0.1:1"],
      ["roots"],
      ["roots", "--url", "http://example.com:80"],
      ["roots", "--url", "http://127.0.0.1:1", "--deadline", "0"],
      ["roots", "--url", "http://127.0.0.1:1", "--deadline", "31000"],
      ["roots", "--url", "http://127.0.0.1:1", "--eval", "x"],
      ["inspect", "--url", "http://127.0.0.1:1"],
      ["inspect", "--url", "http://127.0.0.1:1", "--root", "id?fields=all"],
      ["inspect", "--url", "http://127.0.0.1:1", "--root", "a\u001bb"],
    ];
    for (const argv of misuse) {
      const result = await H.cli(argv, token);
      expect({ argv, exitCode: result.exitCode, stdout: result.stdout }).toEqual({
        argv,
        exitCode: 2,
        stdout: "",
      });
      expect(result.stderr).toContain("error:");
    }
    const help = await H.cli(["--help"], token);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Examples:");

    const noToken = await H.cli(["roots", "--url", "http://127.0.0.1:1"], "");
    expect(noToken.exitCode).toBe(2);

    const placeholder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = placeholder.port ?? 0;
    placeholder.stop(true);
    const unreachable = await H.cliJson<{ readonly error: { readonly _tag: string } }>(
      ["roots", "--url", `http://127.0.0.1:${port}`],
      token,
    );
    expect(unreachable.result.exitCode).toBe(1);
    expect(unreachable.body.error._tag).toBe("GatewayUnreachable");
  }, 20_000);
});
