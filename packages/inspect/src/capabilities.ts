/* oxlint-disable effect/noNodeBuiltinImport -- capability files need an explicit POSIX mode and exclusive creation; node:fs is the platform API for both. */
/**
 * Capability files. The gateway writes its attach and read capabilities to
 * two files that only the owner can read, and removes them when it stops. A
 * capability never appears on stdout or in argv.
 */
import { Effect, Schema } from "effect";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ATTACH_TOKEN_FILE = "attach-token";
export const READ_TOKEN_FILE = "read-token";

/** Owner read and write only. */
export const FILE_MODE = 0o600;
/** Owner only. */
export const DIRECTORY_MODE = 0o700;

export class CapabilityFileError extends Schema.TaggedError<CapabilityFileError>()(
  "CapabilityFileError",
  { path: Schema.String, detail: Schema.String },
) {}

export interface CapabilityFiles {
  readonly attach: string;
  readonly read: string;
}

const attempt = (path: string, action: string, run: () => Promise<unknown>) =>
  Effect.tryPromise({
    try: run,
    catch: () => CapabilityFileError.make({ path, detail: `could not ${action}` }),
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
 * the scope removes the files: the capabilities die with the gateway.
 */
export const write = Effect.fn("InspectCapabilities.write")(function* (
  directory: string,
  tokens: { readonly attach: string; readonly read: string },
) {
  yield* attempt(directory, "create the state directory", () =>
    mkdir(directory, { recursive: true, mode: DIRECTORY_MODE }),
  );
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
