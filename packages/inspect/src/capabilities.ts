/* oxlint-disable effect/noNodeBuiltinImport -- the state directory needs POSIX modes, owner checks, exclusive creation, and a PID liveness probe; node:fs and process are the platform APIs for them. */
/**
 * The gateway's state directory and capability files.
 *
 * - The directory is owned by the current user and has mode 0700.
 * - One gateway owns a directory at a time through `gateway.lock`, which
 *   holds its PID. A lock whose PID is dead is stale and is taken over.
 * - The attach and read capabilities go to two files with mode 0600. The
 *   gateway removes them, and then its lock, when it stops.
 *
 * A capability never appears on stdout or in argv.
 */
import { Effect, Option, Schema } from "effect";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ATTACH_TOKEN_FILE = "attach-token";
export const READ_TOKEN_FILE = "read-token";
export const LOCK_FILE = "gateway.lock";

/** Owner read and write only. */
export const FILE_MODE = 0o600;
/** Owner only. */
export const DIRECTORY_MODE = 0o700;

export class CapabilityFileError extends Schema.TaggedError<CapabilityFileError>()(
  "CapabilityFileError",
  { path: Schema.String, detail: Schema.String },
) {}

/** Another live gateway owns the state directory. */
export class StateDirectoryInUse extends Schema.TaggedError<StateDirectoryInUse>()(
  "StateDirectoryInUse",
  { directory: Schema.String, pid: Schema.Int },
) {}

/** The state directory belongs to another user, or is not a directory. */
export class StateDirectoryRefused extends Schema.TaggedError<StateDirectoryRefused>()(
  "StateDirectoryRefused",
  { directory: Schema.String, detail: Schema.String },
) {}

export interface CapabilityFiles {
  readonly attach: string;
  readonly read: string;
}

const attempt = <A>(path: string, action: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => CapabilityFileError.make({ path, detail: `could not ${action}` }),
  });

/**
 * Create the directory if needed, refuse one another user owns, and set its
 * mode to 0700.
 */
export const prepareDirectory = Effect.fn("InspectCapabilities.prepareDirectory")(function* (
  directory: string,
) {
  yield* attempt(directory, "create the state directory", () =>
    mkdir(directory, { recursive: true, mode: DIRECTORY_MODE }),
  );
  const info = yield* attempt(directory, "read the state directory", () => stat(directory));
  if (!info.isDirectory()) {
    return yield* StateDirectoryRefused.make({ directory, detail: "it is not a directory" });
  }
  if (info.uid !== process.getuid?.()) {
    return yield* StateDirectoryRefused.make({ directory, detail: "another user owns it" });
  }
  yield* attempt(directory, "set the state directory mode", () => chmod(directory, DIRECTORY_MODE));
});

/** True when a process with this PID exists, even one owned by another user. */
const alive = (pid: number): Effect.Effect<boolean> =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) => error instanceof Error && "code" in error && error.code === "EPERM",
  }).pipe(
    Effect.as(true),
    Effect.catch((permissionDenied) => Effect.succeed(permissionDenied)),
  );

const decodePid = Schema.decodeUnknownOption(
  Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
);

const createLock = (path: string, pid: number) =>
  Effect.tryPromise({
    try: () => writeFile(path, `${pid}\n`, { mode: FILE_MODE, flag: "wx" }),
    catch: () => path,
  });

/**
 * Own the state directory for the caller's scope. A live owner refuses the
 * directory; a dead owner's lock is removed and taken once. Closing the
 * scope removes the lock if it is still this process's.
 */
export const lock = Effect.fn("InspectCapabilities.lock")(function* (
  directory: string,
  pid: number,
) {
  const path = join(directory, LOCK_FILE);
  const owner = attempt(path, "read the gateway lock", () => readFile(path, "utf8")).pipe(
    Effect.map((text) => decodePid(text.trim())),
  );
  const take = Effect.gen(function* () {
    const first = yield* Effect.exit(createLock(path, pid));
    if (first._tag === "Success") return;
    const current = yield* owner;
    const live = yield* Option.match(
      Option.filter(current, (other) => other !== pid),
      {
        onNone: () => Effect.succeed(false),
        onSome: alive,
      },
    );
    if (live) {
      return yield* StateDirectoryInUse.make({
        directory,
        pid: Option.getOrElse(current, () => 0),
      });
    }
    // The owner is gone: the lock is stale.
    yield* attempt(path, "remove a stale gateway lock", () => rm(path, { force: true }));
    const second = yield* Effect.exit(createLock(path, pid));
    if (second._tag === "Success") return;
    // Another gateway took it between the two steps.
    return yield* StateDirectoryInUse.make({
      directory,
      pid: Option.getOrElse(yield* owner, () => 0),
    });
  });
  yield* Effect.acquireRelease(take, () =>
    owner.pipe(
      Effect.flatMap((current) => {
        if (Option.exists(current, (other) => other === pid)) {
          return attempt(path, "remove the gateway lock", () => rm(path, { force: true }));
        }
        return Effect.void;
      }),
      Effect.ignore,
    ),
  );
});

/**
 * Create one capability file. An old file is removed first and the new one
 * is created exclusively, so a planted symlink or a file with a wider mode is
 * never reused. `chmod` then fixes the mode against the process umask.
 */
const writeOne = (path: string, token: string) =>
  attempt(path, "remove the old file", () => rm(path, { force: true })).pipe(
    Effect.andThen(
      attempt(path, "create the file", () =>
        writeFile(path, `${token}\n`, { mode: FILE_MODE, flag: "wx" }),
      ),
    ),
    Effect.andThen(attempt(path, "set the file mode", () => chmod(path, FILE_MODE))),
  );

const removeAll = (files: CapabilityFiles) =>
  Effect.forEach([files.attach, files.read], (path) =>
    Effect.ignore(attempt(path, "remove the file", () => rm(path, { force: true }))),
  );

/**
 * Write both capabilities into `directory` for the caller's scope. Closing
 * the scope removes the files: the capabilities die with the gateway. Take
 * `lock` first, so two gateways never overwrite each other's files.
 */
export const write = Effect.fn("InspectCapabilities.write")(function* (
  directory: string,
  tokens: { readonly attach: string; readonly read: string },
) {
  const files: CapabilityFiles = {
    attach: join(directory, ATTACH_TOKEN_FILE),
    read: join(directory, READ_TOKEN_FILE),
  };
  return yield* Effect.acquireRelease(
    writeOne(files.attach, tokens.attach).pipe(
      Effect.andThen(writeOne(files.read, tokens.read)),
      Effect.as(files),
      Effect.tapError(() => removeAll(files)),
    ),
    removeAll,
  );
});
