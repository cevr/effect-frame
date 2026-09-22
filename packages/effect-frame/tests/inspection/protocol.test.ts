/**
 * The public `effect-frame/inspection` protocol: the version constants, the
 * reader documents, the error-to-status map, and the root-link RPC codec
 * round-trip a real Frame snapshot. The subpath also bundles for a browser
 * with no Bun or Node module.
 */
import { Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import * as Frame from "effect-frame/frame";
import { Protocol } from "effect-frame/inspection";
import { Rpc, RpcSerialization } from "effect/unstable/rpc";

const root = { id: "frame-root-1", name: "notes", incarnation: 3, attachedAt: 1_700_000_000 };

/** Encode to JSON text and decode it back, as the gateway and reader do. */
const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) =>
  Effect.gen(function* () {
    const wire = Schema.fromJsonString(schema);
    const text = yield* Schema.encodeEffect(wire)(value);
    const decoded = yield* Schema.decodeUnknownEffect(wire)(text);
    const again = yield* Schema.encodeEffect(wire)(decoded);
    return { text, decoded, again };
  });

const frameLayer = Frame.layer({ name: "protocol-test" });

describe("effect-frame/inspection protocol", () => {
  it.effect("names version 1 on every boundary", () =>
    Effect.sync(() => {
      expect(Protocol.PROTOCOL_VERSION).toBe(1);
      expect(Protocol.ROOT_SUBPROTOCOL).toBe("effect-frame-inspection.v1");
      expect(Protocol.ATTACH_TOKEN_PREFIX).toBe("effect-frame-attach.");
      expect(Protocol.VERSION_HEADER).toBe("effect-frame-inspection-version");
      expect([Protocol.ATTACH_PATH, Protocol.ROOTS_PATH, Protocol.INSPECT_PATH]).toEqual([
        "/v1/attach",
        "/v1/roots",
        "/v1/inspect",
      ]);
      expect(Protocol.DEFAULT_DEADLINE_MILLIS).toBe(5_000);
      expect(Protocol.MAX_DEADLINE_MILLIS).toBe(30_000);
    }),
  );

  it.scopedLive.layer(frameLayer)(
    "round-trips reader documents that carry a real Frame snapshot",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Frame.inspect;
        const inspection = yield* roundTrip(Protocol.ReaderResponse, {
          _tag: "Inspection",
          version: 1,
          root,
          snapshot,
        });
        expect(inspection.again).toBe(inspection.text);
        expect(inspection.decoded._tag).toBe("Inspection");

        const roots = yield* roundTrip(Protocol.ReaderResponse, {
          _tag: "Roots",
          version: 1,
          roots: [root, { ...root, id: "frame-root-2", name: "notes-2" }],
        });
        expect(roots.again).toBe(roots.text);

        const ambiguous = yield* roundTrip(Protocol.ErrorResponse, {
          _tag: "Error",
          version: 1,
          error: { _tag: "AmbiguousRoot", selector: "frame-root-", candidates: [root] },
        });
        expect(ambiguous.decoded.error._tag).toBe("AmbiguousRoot");
      }),
  );

  it.effect("refuses a document of another version", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownExit(Protocol.ReaderResponse);
      expect(Exit.isFailure(decode({ _tag: "Roots", version: 2, roots: [] }))).toBe(true);
      expect(Exit.isSuccess(decode({ _tag: "Roots", version: 1, roots: [] }))).toBe(true);
      const request = Schema.decodeUnknownExit(Protocol.InspectRequest);
      expect(Exit.isFailure(request({ version: 2, root: "x", deadlineMillis: 10 }))).toBe(true);
    }),
  );

  it.effect("maps every gateway error to one HTTP status", () =>
    Effect.sync(() => {
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
        expect({ tag: error._tag, valid: is(error), status: Protocol.statusOf(error) }).toEqual({
          tag: error._tag,
          valid: true,
          status,
        });
      }
    }),
  );

  it.effect("accepts only printable, short root IDs", () =>
    Effect.sync(() => {
      const is = Schema.is(Protocol.RootId);
      expect(is("frame-root-3f2a")).toBe(true);
      expect(is("a:b.c_d-e")).toBe(true);
      expect(is("")).toBe(false);
      expect(is("has space")).toBe(false);
      expect(is("x".repeat(129))).toBe(false);
    }),
  );

  it.scopedLive.layer(frameLayer)(
    "carries a snapshot and SnapshotTooLarge over the Inspect RPC codec",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Frame.inspect;
        const codec = Schema.fromJsonString(
          RpcSerialization.json.codecFor(Rpc.exitSchema(Protocol.Inspect)),
        );
        const overTheWire = (exit: Exit.Exit<Frame.Snapshot, Protocol.SnapshotTooLarge>) =>
          Schema.encodeEffect(codec)(exit).pipe(Effect.flatMap(Schema.decodeUnknownEffect(codec)));
        const success = yield* overTheWire(Exit.succeed(snapshot));
        expect(Exit.isSuccess(success)).toBe(true);
        const tooLarge = yield* overTheWire(
          Exit.fail({ _tag: "SnapshotTooLarge", bytes: 9, limit: 1 }),
        );
        expect(Exit.isFailure(tooLarge)).toBe(true);
      }),
  );

  it.effect("bundles for a browser without Bun, Node, or a gateway", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [new URL("../../src/inspection/index.ts", import.meta.url).pathname],
          target: "browser",
          format: "esm",
          conditions: ["browser", "source"],
          metafile: true,
        }),
      );
      expect(result.success).toBe(true);
      const inputs = Option.match(Option.fromNullishOr(result.metafile), {
        onNone: () => [],
        onSome: (metafile) => Object.keys(metafile.inputs),
      });
      expect(inputs.filter((input) => /^(bun|node:)/.test(input))).toEqual([]);
      expect(inputs.some((input) => input.includes("src/inspection/attach.ts"))).toBe(true);
      const text = (yield* Effect.forEach(result.outputs, (output) =>
        Effect.promise(() => output.text()),
      )).join("\n");
      expect(text.includes("Bun.serve")).toBe(false);
      expect(/(from\s*|import\(\s*|require\(\s*)["'](node:|bun["'])/.test(text)).toBe(false);
    }),
  );
});
