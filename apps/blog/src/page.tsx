import type { RemoteActorRef } from "effect-frame/actor/client";
import { Source } from "effect-frame/actor/client";
import { Router } from "effect-frame/router";
import type { Route } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect } from "effect";
import type { Slug, Reactions } from "./contract.js";
import { Heart } from "./contract.js";
import type { Block, PostBodyValue } from "./queries.js";
import type { post } from "./segments.js";

/**
 * One post, and its one island: the reactions to it. The body is a baked
 * query value; the island is a live actor that the page resumes from the
 * revision it was drawn at (#23 §3). The view is the same at build, per
 * request, and in the browser.
 */

export type PostProps = Route.PropsOf<typeof post>;

const empty: PostBodyValue = { title: "", date: "", blocks: [] };

/** A block and its place, so a new post redraws a place whose kind changed. */
interface Placed {
  readonly key: string;
  readonly block: Block;
}

const placed = (body: PostBodyValue): ReadonlyArray<Placed> =>
  body.blocks.map((block, at) => ({ key: `${String(at)}:${block._tag}`, block }));

/** One block. Its key names its kind, so a row never changes tag. */
const BlockView = (one: Source<Placed>) =>
  Effect.map(one.get, (current) => {
    const text = View.bind(one, (value) => value.block.text);
    if (current.block._tag === "Heading") {
      return <h2>{text}</h2>;
    }
    return <p>{text}</p>;
  });

interface IslandProps {
  readonly slug: Slug;
  readonly reactions: RemoteActorRef<typeof Reactions>;
}

/**
 * The island: the hearts, and a form that adds one. With no script the
 * form posts. With one, it sends over the transport. The first press
 * carries the id the server minted into the page, which is supplied, so it
 * is not predicted and the count moves when the server confirms it; a later
 * press mints its own id, and the behavior the route opened the reference
 * with predicts it.
 */
const Island = (props: IslandProps) =>
  Effect.gen(function* () {
    const here = yield* (yield* Router).current.get;
    const heart = yield* View.form({
      ref: props.reactions,
      message: Heart,
      typed: [],
      endpoint: "/actors",
      returnTo: here.url.pathname,
    });
    return (
      <aside id="reactions" data-slug={props.slug}>
        <form id="heart" onSubmit={heart.submit}>
          <button id="heart-button" type="submit">
            heart
          </button>
        </form>
        <output id="hearts">{View.bind(props.reactions.state, (state) => state.hearts)}</output>
      </aside>
    );
  });

interface Opened {
  readonly slug: Slug;
  readonly reactions: RemoteActorRef<typeof Reactions>;
}

export const PostView = (props: PostProps) =>
  Effect.gen(function* () {
    // A failed read goes to the nearest `Errored`; a built page has none.
    const body = yield* View.ready(yield* View.orErrored(props.data.body.state), empty);
    const opened = (reactions: RemoteActorRef<typeof Reactions>) =>
      Effect.map(props.params.get, (params): Opened => ({ slug: params.slug, reactions }));
    const blocks = yield* View.list({
      each: Source.select(body, placed),
      keyBy: (one: Placed) => one.key,
      row: BlockView,
    });
    // One island per post: a move to another post opens a new one.
    const island = yield* View.keyed(
      Source.mapEffect(props.data.reactions, opened),
      (one) => one.slug,
      (one) =>
        Effect.flatMap(one.get, (current) =>
          Island({ slug: current.slug, reactions: current.reactions }),
        ),
    );
    return (
      <article id="post">
        <h1 id="title">{View.bind(body, (value) => value.title)}</h1>
        <time id="date">{View.bind(body, (value) => value.date)}</time>
        <div id="body">{blocks}</div>
        {island}
      </article>
    );
  });
