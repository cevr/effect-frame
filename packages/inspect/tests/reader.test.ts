/* oxlint-disable effect/noAsyncFunction, effect/noGlobals -- a fake gateway returns a hostile snapshot to the real reader over loopback HTTP. */
/**
 * The reader's text view escapes every snapshot string, and the private
 * limits stay equal to the public schema bounds.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { Protocol } from "effect-frame/inspection";
import { MAX_DEADLINE_MILLIS, statusOf } from "../src/limits.js";
import * as Reader from "../src/reader.js";

const OSC = "\u001b]0;pwned\u0007";
const CSI = "\u001b[2J";
const BEL = "\u0007";
const C1_CSI = "\u009b31m";
const BIDI = "‮evil⁦";
const DEL = "\u007f";
const HOSTILE = `${OSC}${CSI}${BEL}${C1_CSI}${BIDI}${DEL}`;

/** Every code point the text view must never print raw. */
// oxlint-disable-next-line no-control-regex -- the test looks for exactly these.
const RAW = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Record fields as the wire carries them; a top-level record has no parent. */
const record = (id: string): { readonly id: string } =>
  JSON.parse(`{"id":"${id}","ownerId":"owner-1","parentOwnerId":null}`);

const inspection = {
  _tag: "Inspection",
  version: 1,
  root: { id: "frame-root-1", name: "app", incarnation: 1, attachedAt: 1 },
  snapshot: {
    version: 1,
    root: { id: "frame-root-1", name: `app${HOSTILE}` },
    collection: "sampled",
    startedAt: 1,
    finishedAt: 2,
    mounts: [],
    routes: [
      {
        _tag: "Route",
        ...record("route-1"),
        routerId: "router-1",
        routeInstanceId: "route-instance-1",
        routeName: `book${HOSTILE}`,
        phase: "mounted",
        params: { _tag: "Value", value: {} },
        search: { _tag: "Value", value: {} },
        canonicalRouteName: "book",
        canonicalUrl: `/books/7${HOSTILE}`,
      },
    ],
    actors: [],
    queries: [],
    urlStates: [],
    commands: {
      _tag: "Available",
      records: [
        {
          _tag: "Command",
          ...record("command-1"),
          kind: "remote",
          commandId: `cmd${HOSTILE}`,
          identity: "fresh",
          attempt: 1,
          running: false,
          lifecycle: { _tag: "Sent" },
        },
      ],
    },
  },
};

describe("reader text view", () => {
  it("escapes OSC, CSI, BEL, C1, DEL, and bidi controls in every snapshot string", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json(inspection),
    });
    const argv = ["inspect", "--url", `http://127.0.0.1:${server.port}`, "--root", "frame-root-1"];
    const read = (extra: ReadonlyArray<string>) =>
      Effect.runPromise(Reader.run([...argv, ...extra], { token: "t".repeat(64) }));
    const both = async () => ({ text: await read([]), json: await read(["--json"]) });
    const { text: result, json } = await both().finally(() => server.stop(true));
    expect(result.exitCode).toBe(0);
    expect(RAW.test(result.stdout)).toBe(false);
    const escaped = "\\u{1b}]0;pwned\\u{7}\\u{1b}[2J\\u{7}\\u{9b}31m\\u{202e}evil\\u{2066}\\u{7f}";
    expect(result.stdout).toContain(`book${escaped}`);
    expect(result.stdout).toContain(`/books/7${escaped}`);
    expect(result.stdout).toContain(`cmd${escaped}`);
    // --json keeps the exact strings; JSON string escaping keeps C0 inert.
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toContain(JSON.stringify(`book${HOSTILE}`));
  });
});

describe("private limits", () => {
  it("keep the reader deadline bound equal to the public schema bound", () => {
    const deadline = Schema.is(Protocol.DeadlineMillis);
    expect(deadline(MAX_DEADLINE_MILLIS)).toBe(true);
    expect(deadline(MAX_DEADLINE_MILLIS + 1)).toBe(false);
  });

  it("map every gateway error to one HTTP status", () => {
    const errors: ReadonlyArray<[Protocol.GatewayError, number]> = [
      [{ _tag: "UnsupportedProtocolVersion", received: "2", supported: [1] }, 400],
      [{ _tag: "MalformedRequest", detail: "x" }, 400],
      [{ _tag: "InvalidDeadline", deadlineMillis: 0, maximum: 30_000 }, 400],
      [{ _tag: "Unauthorized" }, 401],
      [{ _tag: "ForbiddenOrigin", origin: "http://x" }, 403],
      [{ _tag: "ForbiddenHost", host: "x" }, 403],
      [{ _tag: "NotFound", path: "/x" }, 404],
      [{ _tag: "RootNotFound", selector: "x", attached: 0 }, 404],
      [{ _tag: "AmbiguousRoot", selector: "x", candidates: [] }, 409],
      [{ _tag: "SnapshotTooLarge", bytes: 2, limit: 1 }, 413],
      [{ _tag: "RootDisconnected", root: "x", incarnation: 1 }, 502],
      [{ _tag: "RootProtocolError", root: "x", incarnation: 1, detail: "x" }, 502],
      [{ _tag: "TooManyRoots", limit: 64 }, 503],
      [{ _tag: "DeadlineExceeded", root: "x", deadlineMillis: 1 }, 504],
    ];
    const is = Schema.is(Protocol.GatewayError);
    for (const [error, status] of errors) {
      expect({ tag: error._tag, valid: is(error), status: statusOf(error) }).toEqual({
        tag: error._tag,
        valid: true,
        status,
      });
    }
  });
});
