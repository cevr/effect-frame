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
      expect(Protocol.wire).toEqual({
        version: 1,
        subprotocol: "effect-frame-inspection.v1",
        attachTokenPrefix: "effect-frame-attach.",
        versionHeader: "effect-frame-inspection-version",
        attachPath: "/v1/attach",
        rootsPath: "/v1/roots",
        inspectPath: "/v1/inspect",
      });
      // The public surface holds no SCREAMING constants.
      expect(Object.keys(Protocol).filter((key) => /^[A-Z_]+$/.test(key))).toEqual([]);
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

  it.effect("keeps an uncertain command's unadmitted pass as null on the wire", () =>
    Effect.gen(function* () {
      const wire = Schema.fromJsonString(Frame.CommandLifecycle);
      const encode = Schema.encodeEffect(wire);
      const decode = Schema.decodeUnknownEffect(wire);
      const none: Frame.CommandLifecycle = {
        _tag: "Uncertain",
        attempt: 2,
        admitted: Option.none(),
      };
      const some: Frame.CommandLifecycle = {
        _tag: "Uncertain",
        attempt: 2,
        admitted: Option.some(5),
      };
      const noneText = '{"_tag":"Uncertain","attempt":2,"admitted":null}';
      expect(yield* encode(none)).toBe(noneText);
      expect(yield* encode(some)).toBe('{"_tag":"Uncertain","attempt":2,"admitted":5}');
      expect(yield* decode(noneText)).toEqual(none);
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

  it.effect("puts the request contract in the schema", () =>
    Effect.sync(() => {
      const request = Schema.is(Protocol.InspectRequest);
      const valid = { version: 1, root: "frame-root-1", deadlineMillis: 5_000 };
      expect(request(valid)).toBe(true);
      expect(request({ ...valid, deadlineMillis: 1 })).toBe(true);
      expect(request({ ...valid, deadlineMillis: 30_000 })).toBe(true);
      expect(request({ ...valid, deadlineMillis: 0 })).toBe(false);
      expect(request({ ...valid, deadlineMillis: 30_001 })).toBe(false);
      expect(request({ ...valid, deadlineMillis: 1.5 })).toBe(false);
      expect(request({ ...valid, root: "" })).toBe(false);
      expect(request({ ...valid, root: "x".repeat(256) })).toBe(true);
      expect(request({ ...valid, root: "x".repeat(257) })).toBe(false);
      for (const control of ["\u0007", "\u001b[2J", "\u007f", "\u009b"]) {
        expect({ control, valid: request({ ...valid, root: `a${control}b` }) }).toEqual({
          control,
          valid: false,
        });
      }
      const info = Schema.is(Protocol.RootInfo);
      expect(info(root)).toBe(true);
      expect(info({ ...root, id: "has space" })).toBe(false);
      expect(info({ ...root, name: "bad\u001b]0;x\u0007" })).toBe(false);
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
