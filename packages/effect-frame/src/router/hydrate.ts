// Relative: the form and record plumbing is the framework's, not the public
// `Form` and `Streaming` namespaces.
import * as Form from "../actor/form.js";
import * as Streaming from "../actor/streaming.js";
import { Dom, View } from "effect-frame/view";
import { Deferred, Effect, Option } from "effect";
import type { OpWireService } from "./driven.js";
import { WireGate } from "./driven.js";
import type { MountOptions } from "./router.js";
import { mount } from "./router.js";

/**
 * The client half of a page load (#22 §5, #36). One call reads the records
 * the document carries, puts them in the query cache, reads the issues of a
 * refused plain post when the document carries them (`Form.issuesScriptId`),
 * mounts the route tree over the server's nodes under those issues, and
 * lets the seed go once hydration is done. An app writes no page-load
 * sequence of its own. A
 * `ClientOnly` document has an empty root, so the same call draws it fresh.
 *
 * It is the one owner that sees both the end of the record channel
 * (`Streaming.Resumed.closed`) and the end of hydration (`finish`), so it
 * owns the op wire's start: a driven leaf connects only after both. `wire`
 * is the only way a page reaches the op wire.
 */
export interface HydrateOptions<R, N = R> extends Omit<
  MountOptions<R, Dom.DomNode, N>,
  "host" | "root"
> {
  readonly root: Dom.DomNode;
  /** The op wire for the page's driven leaves. Absent: each keeps its document's drawing. */
  readonly wire?: OpWireService;
}

/** The issues of a refused plain post, when the document carries them. */
const readIssues: Effect.Effect<Option.Option<Form.FormIssues>> = Effect.suspend(() =>
  Option.match(Dom.readJsonScript(Form.issuesScriptId), {
    onNone: () => Effect.succeed(Option.none<Form.FormIssues>()),
    onSome: (json) => Effect.map(Effect.orDie(Form.decodeIssues(json)), Option.some),
  }),
);

export const hydrate = <R, N = R>(options: HydrateOptions<R, N>) =>
  Effect.gen(function* () {
    const records = yield* Dom.readRecords;
    const resumed = yield* Streaming.resume(records);
    const issues = yield* readIssues;
    const over = yield* Deferred.make<void>();
    const hydration = Dom.hydrate(options.root);
    const mounting = Form.provideIssues(issues)(
      mount<R, Dom.DomNode, N>({ ...options, host: hydration.host }),
    );
    const router = yield* Option.match(Option.fromNullishOr(options.wire), {
      onNone: () => mounting,
      onSome: (wire) =>
        Effect.provideService(mounting, WireGate, { wire, over: Deferred.await(over) }),
    });
    yield* View.flush;
    const report = yield* hydration.finish;
    // Seeds that no view took are dropped now; a later declaration reads fresh.
    yield* resumed.hydrated;
    // The document is over once its record channel has ended too.
    yield* Effect.forkScoped(Effect.andThen(resumed.closed, Deferred.succeed(over, void 0)));
    return { router, report, resumed };
  });
