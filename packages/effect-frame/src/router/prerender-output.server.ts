import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import type { Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * Where a prerender build writes, and how a finished build becomes the one
 * the server reads (#86, `docs/design/prerender.md`). An output directory
 * holds immutable generations and one pointer:
 *
 * ```text
 * <out>/current.json          { "generation": "<id>" }: the published build
 * <out>/generations/<id>/     one complete build: pages, client.js, manifest.json
 * <out>/staging/<id>/         a build still being written; never served
 * <out>/build.lock            held by the one build that writes <out>
 * ```
 *
 * A build writes into `staging`, moves the finished directory into
 * `generations` with one rename, and publishes it by replacing
 * `current.json` with one rename. Every step before that last rename leaves
 * the previous generation published. A generation is never written again,
 * so a server that loaded one reads the same bytes until it loads another.
 *
 * Server-only.
 */

/** The file inside a generation the server reads first. */
export const manifestFile = "manifest.json";

/** The pointer's contents. */
const Pointer = Schema.Struct({ generation: Schema.String });
const PointerJson = Schema.fromJsonString(Pointer);
const decodePointer = Schema.decodeUnknownOption(PointerJson);
const encodePointer = Schema.encodeSync(PointerJson);

/** A build's receipt, only as far as recovery reads it. */
const Stamp = Schema.fromJsonString(Schema.Struct({ builtAt: Schema.Finite }));
const decodeStamp = Schema.decodeUnknownOption(Stamp);

/**
 * Another build holds the output directory. One build writes one output at
 * a time. A build that crashed before it released the lock leaves the
 * file; remove it by hand once no build runs.
 */
export class PrerenderBuildLocked extends Schema.TaggedError<PrerenderBuildLocked>()(
  "PrerenderBuildLocked",
  { out: Schema.String, lock: Schema.String },
) {
  override get message(): string {
    return `another prerender build holds ${this.out}. Wait for it, or remove ${this.lock} if no build runs.`;
  }
}

/** The paths of one output directory. */
export interface Output {
  readonly out: string;
  readonly pointer: string;
  readonly generations: string;
  readonly staging: string;
  readonly lock: string;
}

export const outputOf = (path: Path.Path, out: string): Output => ({
  out,
  pointer: path.join(out, "current.json"),
  generations: path.join(out, "generations"),
  staging: path.join(out, "staging"),
  lock: path.join(out, "build.lock"),
});

const isAlreadyExists = (error: PlatformError): boolean => error.reason._tag === "AlreadyExists";

/**
 * Hold the output for this scope. The lock file is created exclusively:
 * a second build fails with `PrerenderBuildLocked` instead of waiting.
 */
export const lock = (
  fs: FileSystem.FileSystem,
  output: Output,
): Effect.Effect<void, PrerenderBuildLocked | PlatformError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.andThen(
      fs.makeDirectory(output.out, { recursive: true }),
      fs
        .writeFileString(output.lock, "", { flag: "wx" })
        .pipe(
          Effect.catchIf(isAlreadyExists, () =>
            Effect.fail(PrerenderBuildLocked.make({ out: output.out, lock: output.lock })),
          ),
        ),
    ),
    () => Effect.ignore(fs.remove(output.lock)),
  );

/**
 * A fresh directory to write one build into. It is removed when the scope
 * fails; once `publish` moved it, there is nothing left to remove.
 */
export const stage = (
  fs: FileSystem.FileSystem,
  output: Output,
  builtAt: number,
): Effect.Effect<string, PlatformError, Scope.Scope> =>
  Effect.andThen(
    fs.makeDirectory(output.staging, { recursive: true }),
    Effect.acquireRelease(
      fs.makeTempDirectory({ directory: output.staging, prefix: `${String(builtAt)}-` }),
      (directory, exit) => {
        if (Exit.isFailure(exit)) {
          return Effect.ignore(fs.remove(directory, { recursive: true }));
        }
        return Effect.void;
      },
    ),
  );

/** The generation the pointer names, when it decodes. */
const pointed = (fs: FileSystem.FileSystem, output: Output) =>
  Effect.map(Effect.option(fs.readFileString(output.pointer)), (text): Option.Option<string> =>
    Option.map(Option.flatMap(text, decodePointer), (pointer) => pointer.generation),
  );

/**
 * Publish a finished staging directory: move it into `generations`, then
 * replace the pointer. The previous generation is kept, so a server that
 * loaded it keeps its bytes; older ones, and what crashed builds left, are
 * removed after the pointer moved. That clean-up is best effort: the new
 * generation is already published.
 *
 * The two renames run with interruption masked. A rename can replace
 * `current.json` before its Effect resumes, so an interruption there would
 * not say whether the commit happened. Masked, a rename either fails, and
 * the commit is known not to have happened, or succeeds. The new generation
 * is removed only after a failed rename: a rename that fails did not
 * replace its target. Reading the previous pointer and writing the new one to a temporary
 * file stay interruptible: they commit nothing.
 */
export const publish = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  output: Output,
  staged: string,
): Effect.Effect<string, PlatformError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const id = path.basename(staged);
      const generation = path.join(output.generations, id);
      const written = path.join(output.out, `current.json.${id}.tmp`);
      const previous = yield* restore(pointed(fs, output));
      yield* restore(
        Effect.andThen(
          fs.makeDirectory(output.generations, { recursive: true }),
          fs.writeFileString(written, encodePointer({ generation: id })),
        ).pipe(Effect.onError(() => Effect.ignore(fs.remove(written)))),
      );
      // The commit: masked, so it ends as a known success or a known failure.
      yield* Effect.andThen(fs.rename(staged, generation), fs.rename(written, output.pointer)).pipe(
        Effect.onError(() =>
          Effect.andThen(
            Effect.ignore(fs.remove(written)),
            Effect.ignore(fs.remove(generation, { recursive: true })),
          ),
        ),
      );
      yield* restore(Effect.ignore(clean(fs, path, output, [id, ...Option.toArray(previous)])));
      return generation;
    }),
  );

/** Remove every generation but `keep`, every staging directory, and every stray pointer. */
const clean = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  output: Output,
  keep: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    for (const name of yield* fs.readDirectory(output.generations)) {
      if (!keep.includes(name)) {
        yield* fs.remove(path.join(output.generations, name), { recursive: true });
      }
    }
    if (yield* fs.exists(output.staging)) {
      for (const name of yield* fs.readDirectory(output.staging)) {
        yield* fs.remove(path.join(output.staging, name), { recursive: true });
      }
    }
    for (const name of yield* fs.readDirectory(output.out)) {
      if (name.startsWith("current.json.") && name.endsWith(".tmp")) {
        yield* fs.remove(path.join(output.out, name));
      }
    }
  });

/** A generation's `builtAt`, when its manifest is there and decodes. */
const stampOf = (fs: FileSystem.FileSystem, path: Path.Path, directory: string) =>
  Effect.map(
    Effect.option(fs.readFileString(path.join(directory, manifestFile))),
    (text): Option.Option<number> =>
      Option.map(Option.flatMap(text, decodeStamp), (stamp) => stamp.builtAt),
  );

/**
 * The generation to serve. The pointer wins when it names a generation
 * with a manifest. Otherwise, after a crash or a hand edit, the newest
 * generation with a manifest wins, by `builtAt` and then by name. Staging
 * is never served. `None`: nothing was ever published.
 */
export const current = (
  output: Output,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const named = yield* pointed(fs, output);
    if (Option.isSome(named)) {
      const directory = path.join(output.generations, named.value);
      if (Option.isSome(yield* stampOf(fs, path, directory))) {
        return Option.some(directory);
      }
    }
    const names = yield* Effect.orElseSucceed(
      fs.readDirectory(output.generations),
      (): ReadonlyArray<string> => [],
    );
    let newest: Option.Option<{ readonly directory: string; readonly builtAt: number }> =
      Option.none();
    for (const name of names.toSorted()) {
      const directory = path.join(output.generations, name);
      const stamp = yield* stampOf(fs, path, directory);
      if (Option.isSome(stamp)) {
        const later = Option.match(newest, {
          onNone: () => true,
          onSome: (found) => stamp.value >= found.builtAt,
        });
        if (later) {
          newest = Option.some({ directory, builtAt: stamp.value });
        }
      }
    }
    return Option.map(newest, (found) => found.directory);
  });
