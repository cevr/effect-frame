import { ActorHost, implementTransparent } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { BunServices } from "@effect/platform-bun";
import type { FileSystem, Path } from "effect";
import { Layer } from "effect";
import { reactionsBehavior } from "./behavior.js";
import { Reactions } from "./contract.js";
import { policies } from "./policies.server.js";
import type { PostSource } from "./posts.server.js";
import { DraftLive, PostBodyLive, PostIndexLive, fromDirectory } from "./posts.server.js";

/**
 * The server half of Blog: the reactions actor, the post queries, and the
 * one host they run in. The server and the build both provide this layer,
 * so a build reads the store the server serves (#23 §2.2). A server module.
 */

export const ReactionsLive = implementTransparent(Reactions, reactionsBehavior);

/** The actor and the queries in this process, over in-memory mailboxes. */
export const host: Layer.Layer<ActorTransport, never, PostSource> = ActorHost.layer({
  implementations: [ReactionsLive],
  queries: [PostIndexLive, PostBodyLive, DraftLive],
  store: ActorHost.memoryStore,
}).pipe(
  Layer.provide(policies),
  // Every name the contract and the queries declare is in the table; a miss is a bug here.
  Layer.orDie,
);

/**
 * The layer the server and the build both run in (#23 §2.2): the host over
 * `posts`, and the platform. One value, two consumers: the build is not a
 * second definition of what the site reads.
 */
export const siteOver = <E>(posts: Layer.Layer<PostSource, E, FileSystem.FileSystem | Path.Path>) =>
  Layer.provideMerge(host, posts).pipe(Layer.provideMerge(BunServices.layer));

/** The site over the Markdown files in `directory`. */
export const site = (directory: string) => siteOver(fromDirectory(directory));
