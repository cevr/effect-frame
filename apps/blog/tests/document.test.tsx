import { registerDom } from "./dom-setup.js";

registerDom();

import { ActorTransport, QueryCache, Streaming } from "effect-frame/actor/client";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Slug } from "../src/contract.js";
import { PostBody, PostIndex } from "../src/queries.js";
import {
  buildInto,
  builtPage,
  clientOver,
  eventually,
  hydrateAt,
  keyText,
  present,
  published,
  storeOf,
  textOf,
  watched,
  workspace,
  writePost,
} from "./fixture.js";
import type { Client } from "./fixture.js";

/**
 * A built Blog page as the browser gets it (#23 §3, #25 §2): the values it
 * baked paint at once, marked stale, and each is read once more to confirm
 * it. See `docs/design/blog-example.md`.
 */

const platform = it.scopedLive.layer(BunServices.layer);

const firstLight = Schema.decodeSync(Slug)("first-light");

/** One seed record, as much of it as these tests read. */
const SeedRecord = Schema.Struct({
  _tag: Schema.String,
  id: Schema.String,
  builtAt: Schema.optional(Schema.Finite),
  revision: Schema.optional(Schema.Finite),
  snapshot: Schema.optional(Schema.String),
});

/** The records a `<script type="application/json" id=...>` holds, or none. */
const scriptJson = (html: string, id: string): ReadonlyArray<typeof SeedRecord.Type> => {
  const open = `<script type="application/json" id="${id}">`;
  const start = html.indexOf(open);
  if (start < 0) {
    return [];
  }
  const body = html.slice(start + open.length, html.indexOf("</script>", start));
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SeedRecord)))(body);
};

const bodyState = (client: Client) =>
  Effect.gen(function* () {
    const cache = yield* QueryCache;
    const entry = yield* cache.open(PostBody, { slug: firstLight });
    return yield* entry.state.get;
  }).pipe(Effect.scoped, Effect.provideContext(client));

describe("a built Blog page (#23 §3)", () => {
  platform(
    "a built page is one finished document: no streamed records, one Patch per declared query stamped with builtAt, and the island's seed",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const manifest = yield* buildInto(yield* storeOf(site.posts), site.out);

        const postHtml = yield* builtPage(site.out, "/posts/first-light");
        expect(postHtml).not.toContain(Streaming.containerId);
        expect(postHtml).not.toContain(Streaming.recordClass);
        const postSeed = scriptJson(postHtml, Streaming.seedId);
        expect(postSeed.map((record) => [record._tag, record.id, record.builtAt])).toEqual([
          [
            "Patch",
            Streaming.recordId({
              query: PostBody.name,
              version: PostBody.version,
              args: '{"slug":"first-light"}',
            }),
            manifest.builtAt,
          ],
        ]);
        expect(scriptJson(postHtml, Streaming.actorSeedId)).toEqual([
          {
            _tag: "ActorSeed",
            id: 'actor:Reactions@1/{"slug":"first-light"}',
            revision: 0,
            snapshot: '{"hearts":0,"ids":[]}',
          },
        ]);

        const indexHtml = yield* builtPage(site.out, "/posts");
        expect(
          scriptJson(indexHtml, Streaming.seedId).map((record) => [record.id, record.builtAt]),
        ).toEqual([
          [
            Streaming.recordId({ query: PostIndex.name, version: PostIndex.version, args: "{}" }),
            manifest.builtAt,
          ],
        ]);
        // The index has no island.
        expect(scriptJson(indexHtml, Streaming.actorSeedId)).toEqual([]);
      }),
  );

  platform(
    "the baked body paints with no skeleton, marked stale, and one read confirms it to Ready{stale:false}",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        yield* buildInto(store, site.out);
        const html = yield* builtPage(site.out, "/posts/first-light");

        const client = watched(Context.get(store, ActorTransport), ["PostBody"]);
        const context = yield* clientOver(client.transport);
        const { report } = yield* hydrateAt(context, html, "/posts/first-light");
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        expect(present("#skeleton")).toBe(false);
        expect(textOf("#title")).toBe("First light");
        const baked = yield* bodyState(context);
        expect(baked._tag === "Ready" && baked.stale).toBe(true);

        // One read per baked key, held; releasing it confirms the value.
        yield* eventually(
          "the revalidation",
          Effect.sync(() => client.reads.length > 0),
        );
        yield* client.release("PostBody");
        yield* eventually(
          "Ready{stale:false}",
          Effect.map(bodyState(context), (state) => state._tag === "Ready" && !state.stale),
        );
        expect(client.reads).toEqual([
          keyText({
            query: PostBody.name,
            version: PostBody.version,
            args: '{"slug":"first-light"}',
          }),
        ]);
        expect(textOf("#title")).toBe("First light");
        expect(present("#skeleton")).toBe(false);
      }),
    10_000,
  );

  platform(
    "a post edited after the build shows its new title once the baked value is confirmed",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        yield* buildInto(store, site.out);
        const html = yield* builtPage(site.out, "/posts/first-light");
        const post = Option.getOrThrow(
          Option.fromNullishOr(published.find((one) => one.slug === "first-light")),
        );
        yield* writePost(site.posts, { ...post, title: "First light, revised" });

        const client = watched(Context.get(store, ActorTransport));
        const context = yield* clientOver(client.transport);
        yield* hydrateAt(context, html, "/posts/first-light");
        yield* eventually(
          "the new title",
          Effect.sync(() => textOf("#title") === "First light, revised"),
        );
        const state = yield* bodyState(context);
        expect(state._tag === "Ready" && !state.stale).toBe(true);
      }),
    10_000,
  );
});
