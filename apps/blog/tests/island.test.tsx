import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, ActorTransport } from "effect-frame/actor/client";
import * as Prerender from "effect-frame/router/prerender";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Reactions, Slug } from "../src/contract.js";
import {
  buildInto,
  builtPage,
  clientOver,
  eventually,
  fetchPage,
  heart,
  hiddenOf,
  hiddenValue,
  hydrateAt,
  reservedPorts,
  serverOver,
  storeOf,
  textOf,
  watched,
  workspace,
} from "./fixture.js";
import type { Store } from "./fixture.js";

/**
 * The one island on a built post (#23 §3.1, #25 §2): the hearts resume
 * from the revision the build baked and catch up over `changes`; with no
 * script, the form posts. See `docs/design/blog-example.md`.
 */

const platform = it.scopedLive.layer(BunServices.layer);

const firstLight = Schema.decodeSync(Slug)("first-light");

/** What the store holds for the first post's hearts. */
const heartsIn = (store: Store) =>
  Effect.gen(function* () {
    const reactions = yield* Actor.remote(Reactions, { slug: firstLight });
    return yield* reactions.state.get;
  }).pipe(Effect.orDie, Effect.scoped, Effect.provideContext(store));

describe("the island on a built post (#23 §3.1)", () => {
  platform(
    "the hearts resume from the baked revision R, call changes after R, and show a heart given after the build",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        yield* heart(store, firstLight, "before");
        yield* buildInto(store, site.out);
        const html = yield* builtPage(site.out, "/posts/first-light");
        expect(html).toContain('<output id="hearts">1</output>');
        yield* heart(store, firstLight, "after");

        const client = watched(Context.get(store, ActorTransport));
        const context = yield* clientOver(client.transport);
        const { report } = yield* hydrateAt(context, html, "/posts/first-light");
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        yield* eventually(
          "two hearts",
          Effect.sync(() => textOf("#hearts") === "2"),
        );
        expect(client.afters).toEqual([1]);
      }),
    10_000,
  );

  platform(
    "a store that no longer holds the baked revision is followed to its newest",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const built = yield* storeOf(site.posts);
        yield* heart(built, firstLight, "one");
        yield* buildInto(built, site.out);
        const html = yield* builtPage(site.out, "/posts/first-light");

        // The store is replaced: a new host, whose history is not the one baked.
        const replaced = yield* storeOf(site.posts);
        yield* heart(replaced, firstLight, "a");
        yield* heart(replaced, firstLight, "b");
        yield* heart(replaced, firstLight, "c");

        const client = watched(Context.get(replaced, ActorTransport));
        const converged = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* clientOver(client.transport);
            yield* hydrateAt(context, html, "/posts/first-light");
            yield* eventually(
              "the newest count",
              Effect.sync(() => textOf("#hearts") === "3"),
            );
          }),
        ).pipe(Effect.timeoutOption("3 seconds"));
        expect(converged._tag).toBe("Some");
        expect(client.afters).toEqual([1]);
      }),
    10_000,
  );

  platform(
    "with no script, the built form posts one heart: its id is not the command id, and a second post of it adds nothing",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        yield* buildInto(store, site.out);
        const server = yield* serverOver(store, site.out);
        expect(reservedPorts).not.toContain(server.port);

        // The page as a reader without JavaScript gets it: the built file.
        const page = yield* fetchPage(`${server.url}/posts/first-light`);
        expect(page.status).toBe(200);
        expect(page.text).toContain(Prerender.clientScript);
        const id = hiddenValue(page.text, "heart", "id");
        const command = hiddenValue(page.text, "heart", "$command");
        expect(id).not.toBe("");
        expect(id).not.toBe(command);

        const body = new URLSearchParams(hiddenOf(page.text, "heart").map(([k, v]) => [k, v]));
        const post = () =>
          fetchPage(`${server.url}/actors/form`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          });
        const first = yield* post();
        const second = yield* post();
        expect([first.status, second.status]).toEqual([303, 303]);
        expect(first.headers.get("location")).toBe("/posts/first-light");
        expect(yield* heartsIn(store)).toEqual({ hearts: 1, ids: [id] });

        // The field is minted at render and stable across the resubmit: the
        // same file carries the same values.
        const again = yield* fetchPage(`${server.url}/posts/first-light`);
        expect(hiddenValue(again.text, "heart", "id")).toBe(id);
        expect(hiddenValue(again.text, "heart", "$command")).toBe(command);
      }),
    20_000,
  );
});
