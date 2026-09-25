import { View } from "effect-frame/view";
import { HttpTransport } from "effect-frame/actor/client";
import { make as makeHost } from "effect-frame/view/opentui";
import type { BaseRenderable } from "@opentui/core";
import { InputRenderable, createCliRenderer } from "@opentui/core";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { demoKey } from "./contract.js";
import { NotesTerminal } from "./terminal-view.js";

/**
 * The terminal entry. It talks to the same server over the same HTTP
 * transport the browser uses, and it observes the same actor. This file is
 * the terminal boundary: the process environment and the TTY live here.
 */

/** The one input may sit under any box, so the walk finds it wherever it is. */
const focusInput = (node: BaseRenderable): boolean => {
  if (node instanceof InputRenderable) {
    node.focus();
    return true;
  }
  for (const child of node.getChildren()) {
    if (focusInput(child)) {
      return true;
    }
  }
  return false;
};

const renderer = Effect.acquireRelease(
  Effect.promise(() => createCliRenderer({ exitOnCtrlC: true })),
  (open) => Effect.sync(() => open.destroy()),
);

const start = Effect.gen(function* () {
  const cli = yield* renderer;
  yield* View.mount(
    NotesTerminal,
    { key: demoKey, resume: Option.none() },
    makeHost(cli),
    cli.root,
  );
  yield* View.flush;
  // A terminal input only receives keys while it holds focus.
  yield* Effect.sync(() => void focusInput(cli.root));
  return yield* Effect.never;
});

// oxlint-disable-next-line node/no-process-env -- the boundary reads the environment once.
const baseUrl = process.env["NOTES_URL"] ?? "http://127.0.0.1:3000";

const transport = HttpTransport.layer({
  baseUrl: `${baseUrl}/actors`,
  reconnect: HttpTransport.defaultReconnect,
}).pipe(Layer.provide(FetchHttpClient.layer));

// The terminal entry point: the one place the client transport is provided.
// @effect-diagnostics-next-line strictEffectProvide:off
await Effect.runPromise(Effect.scoped(Effect.provide(start, transport)));
