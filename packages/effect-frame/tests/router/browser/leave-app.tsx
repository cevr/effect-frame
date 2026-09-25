/* oxlint-disable effect/noNewPromise, effect/noNewError -- this module is the fixture's browser boundary: it reads page config and exposes test controls on window. */
/**
 * The real-browser fixture for route slice 5. One tenant layout and one post
 * leaf, mounted by the real router on the private `browserCommit` Location.
 * The post's view registers one leave check. Test controls live on
 * `window.__leave`: the check's mode, a held answer, the questions it was
 * asked, the router's diagnostics, and the receipt-returning `navigate`.
 */
import type { Source } from "effect-frame/actor";
import { Location, Route, mount, NavigationBehavior } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { Deferred, Effect, Logger, Option, Schema } from "effect";
import * as LeaveBranch from "../../../src/router/leave-branch.js";
import { browserCommit } from "../../../src/router/browser-commit.js";
import type { Precommit } from "../../../src/router/browser-commit.js";
import * as Leave from "../../../src/router/leave.js";
import * as Receipt from "../../../src/router/receipt.js";

export interface LeaveConfig {
  readonly precommit: Precommit;
}

export interface LeaveWindow {
  readonly config: LeaveConfig;
  /** How the post's check answers. `held` waits for `answer`. */
  mode: "leave" | "stay" | "held";
  /** Every question, as `previous->next:kind`. */
  readonly asked: Array<string>;
  /** The router's warnings. */
  readonly logs: Array<string>;
  /** Questions waiting in `held` mode. */
  held: number;
  answer: (verdict: "Stay" | "Leave") => void;
  navigate: (href: string) => Promise<string>;
  ready: boolean;
}

declare global {
  interface Window {
    __leave: LeaveWindow;
    __leaveConfig: LeaveConfig;
  }
}

const printValues = (values: Route.Values<{ readonly postId: string }, { readonly tab: string }>) =>
  `${values.params.postId}?${values.search.tab}`;

const tenantSegment = Route.segment("tenant", {
  path: "/app/:tenant",
  params: Schema.Struct({ tenant: Schema.String }),
});

const postSegment = Route.child(tenantSegment, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ postId: Schema.String }),
  search: Route.search(Schema.Struct({ tab: Schema.String.pipe(Route.withDefault("read")) })),
});

const start = (): void => {
  let pending = Deferred.makeUnsafe<Leave.LeaveVerdict>();
  const control: LeaveWindow = {
    config: window.__leaveConfig,
    mode: "leave",
    asked: [],
    logs: [],
    held: 0,
    answer: (verdict) => {
      const current = pending;
      pending = Deferred.makeUnsafe<Leave.LeaveVerdict>();
      let decided: Leave.LeaveVerdict = Leave.Leave;
      if (verdict === "Stay") {
        decided = Leave.Stay;
      }
      Effect.runSync(Deferred.succeed(current, decided));
    },
    navigate: () => Promise.reject(new Error("router is not mounted")),
    ready: false,
  };
  window.__leave = control;

  const PostView = (props: Route.PropsOf<typeof postSegment>) =>
    Effect.gen(function* () {
      yield* Leave.onLeave(postSegment, (input) =>
        Effect.gen(function* () {
          control.asked.push(
            `${printValues(input.previous)}->${Option.match(input.next, {
              onNone: () => "exit",
              onSome: printValues,
            })}:${input.kind}`,
          );
          if (control.mode === "stay") {
            return Leave.Stay;
          }
          if (control.mode === "held") {
            control.held += 1;
            const verdict = yield* Deferred.await(pending);
            control.held -= 1;
            return verdict;
          }
          return Leave.Leave;
        }),
      );
      return (
        <article id="post">
          <p id="post-param">{View.bind(props.params, (params) => params.postId)}</p>
          <p id="post-tab">{View.bind(props.search, (search) => search.tab)}</p>
          <textarea id="draft" />
        </article>
      );
    });

  const app = Route.client(
    "app",
    LeaveBranch.layout(tenantSegment, [LeaveBranch.leaf(postSegment, PostView)], (props) =>
      Effect.map(props.outlet, (outlet) => (
        <section id="layout">
          <p id="tenant-param">{View.bind(props.params, (params) => params.tenant)}</p>
          <div style="height: 4000px">{outlet}</div>
        </section>
      )),
    ),
  );

  const NotFound = (props: { readonly url: Source<URL> }) =>
    Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

  const collector = Logger.make((options) => {
    control.logs.push(`${options.logLevel} ${String(options.message)}`);
  });

  const main = Effect.gen(function* () {
    const location = yield* browserCommit(control.config.precommit);
    const found = Option.fromNullishOr(document.getElementById("root"));
    if (Option.isNone(found)) {
      return yield* Effect.die("fixture: no #root element");
    }
    const router = yield* mount({
      landing: NavigationBehavior.Restore,
      traversalReadLimit: "3 seconds",
      routes: [app],
      notFound: NotFound,
      host: Dom.host,
      root: found.value,
    }).pipe(
      Effect.provideService(Location, location),
      Effect.provideService(Logger.CurrentLoggers, new Set([collector])),
    );
    const receipts = Receipt.of(router);
    const context = yield* Effect.context<never>();
    control.navigate = (href) =>
      Effect.runPromiseWith(context)(
        Effect.map(
          receipts.push(href),
          (result) => `${result._tag} ${result.url.pathname}${result.url.search}`,
        ),
      );
    control.ready = true;
    return yield* Effect.never;
  });

  Effect.runFork(Effect.scoped(main));
};

start();
