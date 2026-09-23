import { registerDom } from "./dom-setup.js";

registerDom();

import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { builtPage, generationOf, published, readText, workspace } from "./fixture.js";

/**
 * The deploy build (#38): the app's `build` script compiles the client and
 * then prerenders every page. The gate never runs it; it runs `build:client`
 * only, because the gate does not read content (#23 §2.1). This runs the
 * real script, as a process, over a posts directory of its own. Its file
 * name is not a test name, so `bun test tests/` skips it: `bun run
 * test:deploy` runs it, and CI runs that as a step of its own.
 */

const platform = it.scopedLive.layer(BunServices.layer);

const appDirectory = new URL("..", import.meta.url).pathname;

describe("the Blog deploy build", () => {
  platform(
    "bun run build writes the published page tree",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const child = yield* Effect.sync(() =>
          // oxlint-disable-next-line effect/noGlobals -- the build is a real process.
          Bun.spawn(["bun", "run", "build"], {
            cwd: appDirectory,
            // oxlint-disable-next-line node/no-process-env, effect/noGlobals -- the child inherits the environment, plus its paths.
            env: { ...process.env, BLOG_POSTS: site.posts, BLOG_OUT: site.out },
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const [code, stderr] = yield* Effect.all(
          [
            Effect.promise(() => child.exited),
            // oxlint-disable-next-line effect/noGlobals -- reads the process's own pipe.
            Effect.promise(() => Bun.readableStreamToText(child.stderr)),
          ],
          { concurrency: "unbounded" },
        );
        // The output is shown only when the build failed.
        expect({ code, failed: code === 0 || stderr }).toEqual({ code: 0, failed: true });

        const generation = yield* generationOf(site.out);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* Effect.orDie(fs.exists(`${generation}/client.js`))).toBe(true);
        expect(yield* builtPage(site.out, "/posts")).toContain('<ul id="posts">');
        for (const post of published) {
          expect(yield* builtPage(site.out, `/posts/${post.slug}`)).toContain(
            `<h1 id="title">${post.title}</h1>`,
          );
        }
        expect(yield* readText(`${appDirectory}dist/client.js`)).not.toBe("");
      }),
    60_000,
  );
});
