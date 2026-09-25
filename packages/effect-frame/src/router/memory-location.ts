import { Effect, Queue, Ref, Stream } from "effect";
import type { LocationService } from "./router.js";

/**
 * A `Location` held in memory: a test, a terminal, or any host with no
 * browser history. It starts at one URL, moves when the router moves it,
 * and moves back or forward only when `pop` says so. It has no surface, so
 * a landing places nothing.
 */
export interface MemoryLocation {
  /** The service the router reads: provide it as `Location`. */
  readonly location: LocationService;
  /** The URL it holds now. */
  readonly current: Effect.Effect<URL>;
  /**
   * Every move the router wrote, in order, as `push /path?search#hash` or
   * `replace /path?search#hash`. A `pop` writes nothing here.
   */
  readonly history: Effect.Effect<ReadonlyArray<string>>;
  /** Move to `href` as Back or Forward would: the router follows it. */
  readonly pop: (href: string) => Effect.Effect<void>;
}

/**
 * A memory `Location` at `href`.
 *
 * ```ts
 * const memory = yield* memoryLocation("http://app.test/todos");
 * yield* mount(options).pipe(Effect.provideService(Location, memory.location));
 * ```
 */
export const memoryLocation = (href: string | URL): Effect.Effect<MemoryLocation> =>
  Effect.gen(function* () {
    const start = new URL(href);
    const current = yield* Ref.make(start);
    const written = yield* Ref.make<ReadonlyArray<string>>([]);
    const pops = yield* Queue.unbounded<URL>();
    const write = (kind: "push" | "replace") => (url: URL) =>
      Effect.andThen(
        Ref.set(current, url),
        Ref.update(written, (moves) => [
          ...moves,
          `${kind} ${url.pathname}${url.search}${url.hash}`,
        ]),
      );
    return {
      location: {
        current: Ref.get(current),
        push: write("push"),
        replace: write("replace"),
        pops: Stream.fromQueue(pops),
      },
      current: Ref.get(current),
      history: Ref.get(written),
      pop: (to) =>
        Effect.gen(function* () {
          const url = new URL(to, start);
          yield* Ref.set(current, url);
          yield* Queue.offer(pops, url);
        }),
    };
  });
