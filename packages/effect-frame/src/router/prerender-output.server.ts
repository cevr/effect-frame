import { Effect, Exit, FileSystem, Option, Path, Schema, Scope } from "effect";
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
 * <out>/leases/<id>.<random>/ one loaded site's hold on generation <id>
 * <out>/build.lock            held by the one build that writes <out>
 * ```
 *
 * A build writes into `staging`, moves the finished directory into
 * `generations` with one rename, and publishes it by replacing
 * `current.json` with one rename. Every step before that last rename leaves
 * the previous generation published. A generation is never written again,
 * and one a lease names is never removed, so a server that loaded one reads
 * the same bytes until it releases it, across any number of builds.
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
  readonly leases: string;
  readonly lock: string;
}

export const outputOf = (path: Path.Path, out: string): Output => ({
  out,
  pointer: path.join(out, "current.json"),
  generations: path.join(out, "generations"),
  staging: path.join(out, "staging"),
  leases: path.join(out, "leases"),
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
 * replace the pointer. After the pointer moved, every generation that is
 * neither the new one nor named by a lease is removed, with what crashed
 * builds left: a server that loaded a generation holds it by its lease, so
 * it keeps its bytes however many builds follow. That clean-up is best
 * effort: the new generation is already published.
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
      yield* restore(
        Effect.andThen(
          Effect.andThen(
            fs.makeDirectory(output.generations, { recursive: true }),
            fs.makeDirectory(output.leases, { recursive: true }),
          ),
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
      yield* restore(
        Effect.ignore(
          Effect.flatMap(leased(fs, output), (held) => clean(fs, path, output, [id, ...held])),
        ),
      );
      return generation;
    }),
  );

/**
 * The generations the leases name. A lease is a directory named
 * `<generation>.<random>`: one `mkdtemp` creates it whole, so a lease is
 * either there and names its generation, or not there. The random part
 * holds no dot, so the generation is the name up to the last one.
 */
const leased = (fs: FileSystem.FileSystem, output: Output) =>
  Effect.map(
    Effect.orElseSucceed(fs.readDirectory(output.leases), (): ReadonlyArray<string> => []),
    (names) => names.map((name) => name.slice(0, name.lastIndexOf("."))),
  );

/** Take one lease on `generation`, released when the scope closes. */
const leaseOn = (fs: FileSystem.FileSystem, output: Output, generation: string) =>
  Effect.acquireRelease(
    Effect.andThen(
      fs.makeDirectory(output.leases, { recursive: true }),
      fs.makeTempDirectory({ directory: output.leases, prefix: `${generation}.` }),
    ),
    (lease) => Effect.ignore(fs.remove(lease, { recursive: true })),
  );

/**
 * The published generation, held for this scope: clean-up removes no
 * generation a lease names, so its bytes stay for as long as the scope is
 * open, however many builds publish meanwhile. The lease goes when the
 * scope closes, and the next build removes the generation.
 *
 * Clean-up runs only after the pointer moved. So the lease is written
 * first and the published generation resolved again after it: when it is
 * still the one leased, any later clean-up reads the lease and keeps it.
 * When a build published another meanwhile, that lease is released and the
 * new generation is held instead. A lease left by a process that crashed
 * keeps its generation until the file is removed by hand, as `build.lock`
 * is. `None`: nothing was ever published, and nothing is held.
 */
export const hold = (
  output: Output,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outer = yield* Effect.scope;
    let found = yield* current(output);
    while (Option.isSome(found)) {
      const directory = found.value;
      const attempt = yield* Scope.fork(outer);
      const leasedOn = yield* Effect.exit(
        Scope.provide(leaseOn(fs, output, path.basename(directory)), attempt),
      );
      const again = yield* current(output);
      if (Exit.isSuccess(leasedOn) && Option.contains(again, directory)) {
        return found;
      }
      yield* Scope.close(attempt, Exit.void);
      if (Exit.isFailure(leasedOn) && Option.contains(again, directory)) {
        // The lease cannot be written: serve it unheld rather than not at all.
        return found;
      }
      found = again;
    }
    return found;
  });

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
