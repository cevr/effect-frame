import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { serverOnly } from "@effect-frame/actor";

const bundle = (entry: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [new URL(entry, import.meta.url).pathname],
        target: "browser",
        external: ["effect", "effect-machine"],
      }),
    );
    expect(result.success).toBe(true);
    const outputs = yield* Effect.forEach(result.outputs, (output) =>
      Effect.promise(() => output.text()),
    );
    return outputs.join("\n");
  });

/**
 * The client entry must never carry server code to a browser. The check is
 * a real bundle, not a lint: whatever the client entry reaches is what a
 * page would download.
 */
describe("import boundary", () => {
  it.effect("the client entry bundles without stores, hosts, or implementations", () =>
    Effect.gen(function* () {
      const text = yield* bundle("../src/client.ts");
      expect(text).not.toContain(serverOnly);
      expect(text).not.toContain("@effect-frame/actor/src/mailbox-store/MailboxStore");
      expect(text).not.toContain("@effect-frame/actor/src/host/Authorizer");
      expect(text).not.toContain("@effect-frame/actor/src/durable/DurableHostConfig");
      expect(text).not.toContain("method not allowed");
    }),
  );

  it.effect("the full entry does carry the server modules", () =>
    Effect.gen(function* () {
      const text = yield* bundle("../src/index.ts");
      expect(text).toContain(serverOnly);
    }),
  );
});
