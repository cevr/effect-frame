import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor/client";
import { select } from "effect-frame/actor/client";
import { getOwner } from "@solidjs/signals";
import { Route, renderDocument } from "effect-frame/router";
import { Errored, Loading, View, orErrored, ready } from "effect-frame/view";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Label, frame, makeControl, release, sideOf } from "../view/streaming-fixture.js";
import { NotFound } from "./prerender-fixture.js";

/**
 * An `AwaitAll` render is woken by the drawing it waits on: a boundary that
 * switches, a list row whose setup ends. The drawing calls that wake from
 * inside its own reactive update. The render must not read the page from
 * there: the update is half done, so a bound text can still show its old
 * value and a list may not have built its rows.
 */

/**
 * A bound source that notes, on each read, whether a reactive owner is
 * current. It never changes, so after the drawing binds it, only the
 * render's catch-up reads it: those reads must come from outside the
 * drawing's update, where no owner is current.
 */
const owners: Array<boolean> = [];

const probe: Source<string> = {
  get: Effect.sync(() => {
    owners.push(Option.isSome(Option.fromNullishOr(getOwner())));
    return "probe";
  }),
  changes: Stream.never,
};

const chrome = Route.segment("chrome", { path: "/", params: Schema.Struct({}) });

const post = Route.child(chrome, "post", {
  path: "posts/:slug",
  params: Schema.Struct({ slug: Schema.String }),
  data: ({ params }) => ({ post: Route.query(Label, { id: params.slug }) }),
});

const tree = Route.prerender(
  "posts",
  Route.layout(
    chrome,
    [
      Route.leaf(post, (props) =>
        Effect.gen(function* () {
          const value = yield* ready(yield* orErrored(props.data.post.state), { label: "" });
          const parts = yield* View.list({
            each: select(value, (found) => found.label.split(",").filter((part) => part !== "")),
            keyBy: (part: string) => part,
            // A setup with no suspension: it ends while the list builds the row.
            row: (part) => Effect.map(part.get, (text) => <li>{text}</li>),
          });
          return (
            <article>
              <h1 id="title">{View.bind(value, (found) => found.label)}</h1>
              <p id="probe">{View.bind(probe, (text) => text)}</p>
              <ul>{parts}</ul>
            </article>
          );
        }),
      ),
    ],
    (props) =>
      Effect.map(
        Errored({
          fallback: () => <p id="failed">failed</p>,
          children: Loading({ fallback: <p id="pending">loading</p>, children: props.outlet }),
        }),
        (body) => <main>{body}</main>,
      ),
  ),
  { inputs: [Route.inputs(post, Effect.succeed([{ slug: "a" }]))] },
);

const renderOnce = Effect.gen(function* () {
  // The read answers a moment after the render starts, as a file read does.
  const control = makeControl({ a: "x,y" }, ["a"]);
  const server = yield* sideOf(control);
  yield* Effect.forkScoped(Effect.andThen(Effect.sleep("0 millis"), release(control, "a")));
  const outcome = yield* renderDocument({
    routes: [tree],
    notFound: NotFound,
    url: new URL("http://site.test/posts/a"),
    document: frame,
    closeWhen: Effect.sleep("5 seconds"),
  }).pipe(Effect.provideContext(server));
  if (outcome._tag === "Redirect") {
    return yield* Effect.die("the post redirected");
  }
  expect(outcome.mode).toBe("AwaitAll");
  return Array.from(yield* Stream.runCollect(outcome.body)).join("");
}).pipe(Effect.scoped);

describe("an AwaitAll render woken by its drawing", () => {
  it.scopedLive("catches the drawing up from outside its reactive update", () =>
    Effect.gen(function* () {
      owners.length = 0;
      const html = yield* renderOnce;
      expect(html).toContain('<p id="probe">probe</p>');
      // The first read is the drawing's own, as it binds; every later one is a catch-up.
      expect(owners.length).toBeGreaterThan(1);
      expect(owners.slice(1)).toEqual(owners.slice(1).map(() => false));
    }),
  );

  it.scopedLive(
    "reads the page only once the drawing's update is done: the title and every row are drawn",
    () =>
      Effect.gen(function* () {
        // What a reader sees. The wake lands inside the update on some runs
        // and not others, and a page read there shows the old title only
        // when the title's write is still queued, so this is the symptom;
        // the catch-up test above is the cause, on every run.
        const pages = yield* Effect.forEach(Array.from({ length: 40 }), () => renderOnce);
        const wrong = pages.filter(
          (html) =>
            html.includes("pending") ||
            !html.includes('<h1 id="title">x,y</h1>') ||
            !html.includes("<ul><li>x</li><li>y</li></ul>"),
        );
        expect(wrong).toEqual([]);
      }),
    30_000,
  );
});
