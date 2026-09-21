import type { Applied, SnapshotOf } from "effect-frame/actor/client";
import { HttpTransport, resumeCodec } from "effect-frame/actor/client";
import { Dom, mount, render } from "effect-frame/view";
import { Effect, Option, Schema } from "effect";
import { Notes, demoKey, resumeScriptId } from "./contract.js";
import { NotesPage } from "./page.js";

/**
 * The browser entry. It reads the snapshot the server embedded, adopts the
 * server's nodes, and then follows the actor over the HTTP transport. This
 * file is the browser boundary: `document` and `location` live here only.
 */

const Resume = resumeCodec(Notes);

const readResume = Effect.gen(function* () {
  const embedded = Dom.readJsonScript(resumeScriptId);
  return yield* Option.match(embedded, {
    onNone: () => Effect.succeed(Option.none<Applied<SnapshotOf<typeof Notes>>>()),
    onSome: (json) => Effect.map(Effect.orDie(Schema.decodeEffect(Resume)(json)), Option.some),
  });
});

const start = Effect.gen(function* () {
  const found = yield* Effect.sync(() => Option.fromNullishOr(document.getElementById("app")));
  if (Option.isNone(found)) {
    return yield* Effect.die("notes: no #app element to hydrate");
  }
  const root = found.value;
  const resume = yield* readResume;
  const hydration = Dom.hydrate(root);
  yield* mount(NotesPage, { key: demoKey, resume }, hydration.host, root);
  yield* render;
  const report = yield* hydration.finish;
  if (report.mismatches.length > 0) {
    yield* Effect.logWarning("notes: hydration mismatches", report);
  }
  // The page lives as long as the tab does.
  return yield* Effect.never;
});

const transport = HttpTransport.layer({
  baseUrl: `${location.origin}/actors`,
  reconnect: HttpTransport.defaultReconnect,
});

// The browser entry point: the one place the client transport is provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, transport)));
