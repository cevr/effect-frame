import { implementQuery } from "effect-frame/actor";
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import type { Slug } from "./contract.js";
import { Slug as SlugSchema } from "./contract.js";
import type { Block, PostBodyValue, PostSummary } from "./queries.js";
import { Draft, PostBody, PostIndex } from "./queries.js";

/**
 * Where the posts come from: one Markdown file per post, named
 * `<slug>.md`, with a small front matter. A server module: the browser
 * entry never reaches it (`bun run boundary`).
 *
 * ```md
 * ---
 * title: Hello, world
 * date: 2026-09-01
 * draft: false
 * ---
 * # A heading
 *
 * A paragraph.
 * ```
 */

/** One post as the source holds it. */
export interface Post {
  readonly slug: Slug;
  readonly title: string;
  readonly date: string;
  readonly draft: boolean;
  readonly blocks: ReadonlyArray<Block>;
}

/** A post file whose front matter or name does not decode. */
export class PostUnreadable extends Schema.TaggedError<PostUnreadable>()("PostUnreadable", {
  file: Schema.String,
  reason: Schema.String,
}) {}

/** No post has this slug. */
export class PostMissing extends Schema.TaggedError<PostMissing>()("PostMissing", {
  slug: Schema.String,
}) {}

export interface PostSourceService {
  /** Every post, drafts included, in file-name order. */
  readonly all: Effect.Effect<ReadonlyArray<Post>, PostUnreadable>;
  /** One post by slug, draft or not. */
  readonly one: (slug: Slug) => Effect.Effect<Post, PostUnreadable | PostMissing>;
}

export class PostSource extends Context.Service<PostSource, PostSourceService>()(
  "@effect-frame/example-blog/src/posts.server/PostSource",
) {}

const FrontMatter = Schema.Struct({
  title: Schema.String,
  date: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
  draft: Schema.Literals(["true", "false"]),
});

const decodeFrontMatter = Schema.decodeUnknownEffect(FrontMatter);
const decodeSlug = Schema.decodeUnknownEffect(SlugSchema);

/** `key: value` lines between the two `---` fences, and the text after them. */
const split = (text: string): Option.Option<{ fields: Record<string, string>; body: string }> =>
  Option.map(Option.fromNullishOr(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)), (match) => {
    const head = Option.getOrElse(Option.fromNullishOr(match[1]), () => "");
    const fields: Record<string, string> = {};
    for (const line of head.split("\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
    }
    return { fields, body: Option.getOrElse(Option.fromNullishOr(match[2]), () => "") };
  });

/**
 * The body as blocks: a paragraph per run of lines between blank lines,
 * and a line that starts with `#` is a heading. Nothing else is Markdown
 * here, on purpose: the view draws every tag.
 */
export const blocksOf = (body: string): ReadonlyArray<Block> =>
  body
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk): Block => {
      if (chunk.startsWith("#")) {
        return { _tag: "Heading", text: chunk.replace(/^#+\s*/, "") };
      }
      return { _tag: "Paragraph", text: chunk.split("\n").join(" ") };
    });

const parse = (file: string, slug: Slug, text: string) =>
  Effect.gen(function* () {
    const found = split(text);
    if (Option.isNone(found)) {
      return yield* PostUnreadable.make({ file, reason: "no front matter" });
    }
    const parts = found.value;
    const front = yield* Effect.mapError(decodeFrontMatter(parts.fields), (error) =>
      PostUnreadable.make({ file, reason: error.message }),
    );
    const post: Post = {
      slug,
      title: front.title,
      date: front.date,
      draft: front.draft === "true",
      blocks: blocksOf(parts.body),
    };
    return post;
  });

/** The posts in `directory`, read from disk on every call. */
export const fromDirectory = (directory: string) =>
  Layer.effect(
    PostSource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const readOne = (file: string) =>
        Effect.gen(function* () {
          const slug = yield* Effect.mapError(decodeSlug(path.basename(file, ".md")), (error) =>
            PostUnreadable.make({ file, reason: error.message }),
          );
          const text = yield* Effect.mapError(fs.readFileString(file), (error) =>
            PostUnreadable.make({ file, reason: error.message }),
          );
          return yield* parse(file, slug, text);
        });
      const all = Effect.gen(function* () {
        const names = yield* Effect.mapError(fs.readDirectory(directory), (error) =>
          PostUnreadable.make({ file: directory, reason: error.message }),
        );
        const files = names.filter((name) => name.endsWith(".md")).toSorted();
        return yield* Effect.forEach(files, (name) => readOne(path.join(directory, name)));
      });
      const one = (slug: Slug) =>
        Effect.gen(function* () {
          const file = path.join(directory, `${slug}.md`);
          if (!(yield* Effect.orElseSucceed(fs.exists(file), () => false))) {
            return yield* PostMissing.make({ slug });
          }
          return yield* readOne(file);
        });
      return PostSource.of({ all, one });
    }),
  );

/** The newest first, then by slug, so two posts of one day keep one order. */
const newestFirst = (a: Post, b: Post): number =>
  b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug);

const summaryOf = (post: Post): PostSummary => ({
  slug: post.slug,
  title: post.title,
  date: post.date,
});

const bodyOf = (post: Post): PostBodyValue => ({
  title: post.title,
  date: post.date,
  blocks: post.blocks,
});

/** Every published post, newest first. */
export const PostIndexLive = implementQuery(PostIndex, {
  run: () =>
    Effect.gen(function* () {
      const source = yield* PostSource;
      const posts = yield* source.all;
      return posts
        .filter((post) => !post.draft)
        .toSorted(newestFirst)
        .map(summaryOf);
    }),
});

/** One published post. A draft is missing here: only `Draft` reads it. */
export const PostBodyLive = implementQuery(PostBody, {
  run: (args) =>
    Effect.gen(function* () {
      const source = yield* PostSource;
      const post = yield* source.one(args.slug);
      if (post.draft) {
        return yield* PostMissing.make({ slug: args.slug });
      }
      return bodyOf(post);
    }),
});

/** Any post, draft or not. Its policy admits editors only. */
export const DraftLive = implementQuery(Draft, {
  run: (args) =>
    Effect.gen(function* () {
      const source = yield* PostSource;
      return bodyOf(yield* source.one(args.slug));
    }),
});
