/* oxlint-disable effect/noGlobals, effect/noNullish, effect/noTernary -- this module is the reader transport boundary: fetch, AbortSignal, URL, JSON text, and argv parsing. */
/**
 * The reader commands of the `effect-frame` executable. `run` takes argv and
 * an environment and returns the exit code with stdout and stderr text; it
 * never touches the process. `bin.ts` wires `process.argv`, the token
 * environment variable, SIGINT, and the streams to it.
 *
 *   roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
 *   inspect --url <gateway> --root <id|prefix|name> [--json] [--deadline <ms>]
 *           [--token-file <path>] [--max-text <chars>]
 *
 * Exit codes: 0 success, 1 operational failure, 2 invalid arguments or a
 * missing capability, 130/143/129 on SIGINT/SIGTERM/SIGHUP. Data goes to stdout; diagnostics go
 * to stderr. With `--json`, stdout holds exactly one versioned document for
 * every exit code.
 */
import { Effect, Match, Option, Result, Schema } from "effect";
import { Protocol } from "effect-frame/inspection";
import { DEFAULT_DEADLINE_MILLIS, MAX_DEADLINE_MILLIS } from "./limits.js";
import { InterruptSignal, exitCodeOf, untilInterrupted, type ExitCode } from "./signals.js";
import { escapeText } from "./text.js";

export const TOKEN_ENV = "EFFECT_FRAME_INSPECT_TOKEN";

export interface CliEnvironment {
  /** The value of `EFFECT_FRAME_INSPECT_TOKEN`, if set. */
  readonly token?: string;
  /** Reads a token file. The default uses `Bun.file`. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Aborts the command as SIGINT would. */
  readonly interrupt?: AbortSignal;
}

export interface CliResult {
  readonly exitCode: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

/** Failures the reader detects itself, printed in the same error envelope. */
export const ClientError = Schema.Union([
  Schema.TaggedStruct("GatewayUnreachable", { url: Schema.String }),
  Schema.TaggedStruct("GatewayTimedOut", { deadlineMillis: Schema.Int }),
  Schema.TaggedStruct("MalformedResponse", { status: Schema.Int, detail: Schema.String }),
  Schema.TaggedStruct("InvalidArguments", { message: Schema.String }),
  Schema.TaggedStruct("MissingCapability", { tokenEnv: Schema.String }),
  Schema.TaggedStruct("Interrupted", { signal: InterruptSignal }),
]);
export type ClientError = Schema.Schema.Type<typeof ClientError>;

/**
 * The one document `--json` prints on stdout: a gateway reply, or an error
 * envelope that carries a gateway error or a reader-side error.
 */
export const Document = Schema.Union([
  Protocol.RootsResponse,
  Protocol.InspectResponse,
  Schema.TaggedStruct("Error", {
    version: Schema.Literal(Protocol.wire.version),
    error: Schema.Union([Protocol.GatewayError, ClientError]),
  }),
]);
export type Document = Schema.Schema.Type<typeof Document>;

export const HELP = `Read a live Frame root through an effect-frame gateway.

Usage:
  effect-frame roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
  effect-frame inspect --url <gateway> --root <selector> [--json] [--deadline <ms>]
                       [--token-file <path>] [--max-text <chars>]

Flags:
  --url <gateway>      Loopback gateway, for example http://127.0.0.1:4318
  --root <selector>    Exact root ID, unique ID prefix, or exact root name
  --json               Print exactly one versioned JSON document on stdout
  --deadline <ms>      Finite deadline, 1..${MAX_DEADLINE_MILLIS} (default ${DEFAULT_DEADLINE_MILLIS})
  --token-file <path>  Read capability file (else ${TOKEN_ENV})
  --max-text <chars>   Longest value shown in text output (default 160)
  -h, --help           Show this help

The capability comes from --token-file or ${TOKEN_ENV}, never from a flag.

Examples:
  effect-frame roots --url http://127.0.0.1:4318 --token-file <state-dir>/read-token
  effect-frame inspect --url http://127.0.0.1:4318 --root frame-root-3f2a --json

Exit codes: 0 ok, 1 failure, 2 invalid arguments or no capability,
130/143/129 stopped by SIGINT/SIGTERM/SIGHUP.
`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Parsed {
  readonly command: "roots" | "inspect";
  readonly url: URL;
  readonly root: Option.Option<string>;
  readonly json: boolean;
  readonly deadlineMillis: number;
  readonly tokenFile: Option.Option<string>;
  readonly maxText: number;
}

class Invalid extends Schema.TaggedError<Invalid>()("Invalid", { message: Schema.String }) {}
class Help extends Schema.TaggedError<Help>()("Help", {}) {}

const invalid = (message: string) => Effect.fail(Invalid.make({ message }));

const FLAGS_WITH_VALUES = new Set(["--url", "--root", "--deadline", "--token-file", "--max-text"]);
// The gateway binds 127.0.0.1 only.
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

const integerFlag = (
  values: ReadonlyMap<string, string>,
  flag: string,
  fallback: number,
  max: number,
) =>
  Option.match(Option.fromNullishOr(values.get(flag)), {
    onNone: () => Effect.succeed(fallback),
    onSome: (value) => {
      const number = Number(value);
      return /^[0-9]{1,9}$/.test(value) && number >= 1 && number <= max
        ? Effect.succeed(number)
        : invalid(`${flag} must be an integer from 1 to ${max}`);
    },
  });

const readFlags = Effect.fn("InspectionCli.readFlags")(function* (rest: ReadonlyArray<string>) {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? "";
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(flag)) return yield* invalid(`unknown flag '${flag.slice(0, 32)}'`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return yield* invalid(`${flag} needs a value`);
    }
    if (values.has(flag)) return yield* invalid(`${flag} given twice`);
    values.set(flag, value);
    index += 1;
  }
  return { values, json };
});

const readUrl = (raw: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(raw)) return yield* invalid("--url is required");
    const url = yield* Effect.try({
      try: () => new URL(raw.value),
      catch: () => Invalid.make({ message: "--url does not parse" }),
    });
    if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.port === "") {
      return yield* invalid("--url must be http://<loopback>:<port>");
    }
    return url;
  });

const isSelector = Schema.is(Protocol.RootSelector);

const readRoot = (command: Parsed["command"], root: Option.Option<string>) =>
  Effect.gen(function* () {
    if (command === "inspect" && Option.isNone(root)) {
      return yield* invalid(
        "inspect needs --root <selector>; list roots with: roots --url <gateway>",
      );
    }
    if (command === "roots" && Option.isSome(root)) return yield* invalid("roots takes no --root");
    if (Option.exists(root, (selector) => !isSelector(selector))) {
      return yield* invalid("--root must be 1 to 256 characters with no control characters");
    }
    // A pasted URL fragment is never a root selector.
    if (Option.exists(root, (selector) => /[?#%]/.test(selector))) {
      return yield* invalid("--root must not contain ?, #, or %");
    }
    return root;
  });

const parse = Effect.fn("InspectionCli.parse")(function* (argv: ReadonlyArray<string>) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return yield* Help.make({});
  }
  const [command, ...rest] = argv;
  if (command === undefined) return yield* invalid("missing command");
  if (command !== "roots" && command !== "inspect") {
    return yield* invalid(`unknown command '${command.slice(0, 32)}'; expected roots or inspect`);
  }
  const { values, json } = yield* readFlags(rest);
  const url = yield* readUrl(Option.fromNullishOr(values.get("--url")));
  const root = yield* readRoot(command, Option.fromNullishOr(values.get("--root")));
  const deadlineMillis = yield* integerFlag(
    values,
    "--deadline",
    DEFAULT_DEADLINE_MILLIS,
    MAX_DEADLINE_MILLIS,
  );
  const maxText = yield* integerFlag(values, "--max-text", 160, 100_000);
  return {
    command,
    url,
    root,
    json,
    deadlineMillis,
    tokenFile: Option.fromNullishOr(values.get("--token-file")),
    maxText,
  } satisfies Parsed;
});

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

interface TextBudget {
  readonly max: number;
  truncated: number;
}

const clip = (value: string, budget: TextBudget): string => {
  if (value.length <= budget.max) return value;
  budget.truncated += 1;
  return `${value.slice(0, budget.max)}… [truncated: ${budget.max} of ${value.length} chars]`;
};

const rootLine = (root: Protocol.RootInfo): string =>
  `${root.id}  ${root.name ?? "(unnamed)"}  incarnation ${root.incarnation}`;

/** Every text line passes through here, so no page string reaches the terminal raw. */
const textLines = (lines: ReadonlyArray<string>): string => `${lines.map(escapeText).join("\n")}\n`;

const rootsText = (response: Protocol.RootsResponse): string =>
  response.roots.length === 0 ? "no roots attached\n" : textLines(response.roots.map(rootLine));

type QueryRecord = Protocol.InspectResponse["snapshot"]["queries"][number];

const queryValueText = (value: QueryRecord["value"], budget: TextBudget): string =>
  Match.value(value).pipe(
    Match.tagsExhaustive({
      Absent: () => "(absent)",
      Encoded: (encoded) => clip(encoded.value, budget),
      Unsupported: (unsupported) => `(unsupported: ${unsupported.reason})`,
    }),
  );

const inspectText = (response: Protocol.InspectResponse, maxText: number): string => {
  const budget: TextBudget = { max: maxText, truncated: 0 };
  const snapshot = response.snapshot;
  const lines = [
    `root      ${rootLine(response.root)}`,
    `sampled   ${snapshot.collection} in ${snapshot.finishedAt - snapshot.startedAt}ms`,
    `mounts    ${snapshot.mounts.length}  ${snapshot.mounts.map((mount) => mount.phase).join(", ")}`,
    `routes    ${snapshot.routes.length}`,
    ...snapshot.routes.map(
      (route) => `  ${route.routeName}  ${clip(route.canonicalUrl, budget)}  ${route.phase}`,
    ),
    `actors    ${snapshot.actors.length}`,
    ...snapshot.actors.map((actor) => `  ${actor.kind}  revision ${actor.revision}  ${actor.id}`),
    `queries   ${snapshot.queries.length}`,
    ...snapshot.queries.map(
      (query) =>
        `  ${query.state}  ${clip(query.key, budget)}  age ${query.ageMs}ms  value ${queryValueText(query.value, budget)}`,
    ),
    `urlStates ${snapshot.urlStates.length}`,
    `commands  ${snapshot.commands.records.length}`,
    ...snapshot.commands.records.map(
      (command) =>
        `  ${command.kind}  ${command.lifecycle._tag}  attempt ${command.attempt}  ${runningText(command.running)}  ${command.commandId}`,
    ),
  ];
  if (budget.truncated > 0) {
    lines.push(
      `note      text truncated ${budget.truncated} value(s); --json returns the complete snapshot`,
    );
  }
  return textLines(lines);
};

/** Whether an automatic sequence runs now; a command is never shown with its payload. */
const runningText = (running: boolean): string => {
  if (running) return "running";
  return "idle";
};

const errorText = (error: { readonly _tag: string }): string => {
  const detail = escapeText(JSON.stringify(error));
  switch (error._tag) {
    case "AmbiguousRoot":
      return `error: the selector matches several roots; pass an exact --root\n${detail}\n`;
    case "RootNotFound":
      return `error: no attached root matches; list roots with: roots --url <gateway>\n${detail}\n`;
    case "Unauthorized":
      return `error: the gateway refused the capability; check --token-file or ${TOKEN_ENV}\n`;
    case "MissingCapability":
      return `error: no read capability; pass --token-file <path> or set ${TOKEN_ENV}\n`;
    case "Interrupted":
      return "interrupted\n";
    default:
      return `error: ${escapeText(error._tag)}\n${detail}\n`;
  }
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

class Failed extends Schema.TaggedError<Failed>()("Failed", { error: ClientError }) {}

const clientFailure = (error: ClientError) => Effect.fail(Failed.make({ error }));

const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Protocol.ReaderResponse));

const requestInit = (parsed: Parsed, token: string): RequestInit => {
  const headers = {
    authorization: `Bearer ${token}`,
    [Protocol.wire.versionHeader]: String(Protocol.wire.version),
    "content-type": "application/json",
  };
  if (parsed.command === "roots") return { method: "GET", headers };
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: Protocol.wire.version,
      root: Option.getOrElse(parsed.root, () => ""),
      deadlineMillis: parsed.deadlineMillis,
    }),
  };
};

/**
 * One HTTP exchange. Interrupting this effect aborts the request; the
 * gateway sees the disconnect and cancels its own collection.
 */
const exchange = (parsed: Parsed, token: string) =>
  Effect.gen(function* () {
    const target = new URL(
      parsed.command === "roots" ? Protocol.wire.rootsPath : Protocol.wire.inspectPath,
      parsed.url,
    );
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(target, { ...requestInit(parsed, token), signal }),
      catch: () => Failed.make({ error: { _tag: "GatewayUnreachable", url: parsed.url.origin } }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => Failed.make({ error: { _tag: "GatewayUnreachable", url: parsed.url.origin } }),
    });
    return yield* decodeResponse(text).pipe(
      Effect.catchTag("SchemaError", () =>
        clientFailure({
          _tag: "MalformedResponse",
          status: response.status,
          detail: "the gateway reply is not a versioned reader response",
        }),
      ),
    );
  }).pipe(
    // The gateway enforces the deadline first; this bound covers a stalled link.
    Effect.timeoutOrElse({
      duration: parsed.deadlineMillis + 250,
      orElse: () =>
        clientFailure({ _tag: "GatewayTimedOut", deadlineMillis: parsed.deadlineMillis }),
    }),
  );

const readToken = (parsed: Parsed, environment: CliEnvironment) =>
  Option.match(parsed.tokenFile, {
    onNone: () => Effect.succeed(Option.fromNullishOr(environment.token)),
    onSome: (path) =>
      Effect.tryPromise(() =>
        (environment.readFile ?? ((file: string) => Bun.file(file).text()))(path),
      ).pipe(
        Effect.map((text) => Option.some(text.trim())),
        Effect.catchTag("UnknownError", () => Effect.succeed(Option.none<string>())),
      ),
  });

const awaitInterrupt = (signal: Option.Option<AbortSignal>) =>
  Option.match(signal, { onNone: () => Effect.never, onSome: untilInterrupted });

const result = (exitCode: CliResult["exitCode"], stdout: string, stderr: string): CliResult => ({
  exitCode,
  stdout,
  stderr,
});

const render = (parsed: Parsed, response: Protocol.ReaderResponse): CliResult =>
  Match.value(response).pipe(
    Match.tagsExhaustive({
      Error: (reply) =>
        result(1, parsed.json ? `${JSON.stringify(reply)}\n` : "", errorText(reply.error)),
      Roots: (reply) =>
        result(0, parsed.json ? `${JSON.stringify(reply)}\n` : rootsText(reply), ""),
      Inspection: (reply) =>
        result(
          0,
          parsed.json ? `${JSON.stringify(reply)}\n` : inspectText(reply, parsed.maxText),
          "",
        ),
    }),
  );

/** A reader-side failure: one error document on stdout under --json. */
const failure = (
  exitCode: CliResult["exitCode"],
  json: boolean,
  error: ClientError,
  stderr: string = errorText(error),
): CliResult => {
  const body = { _tag: "Error", version: Protocol.wire.version, error };
  return result(exitCode, json ? `${JSON.stringify(body)}\n` : "", stderr);
};

const execute = (parsed: Parsed, environment: CliEnvironment) =>
  Effect.gen(function* () {
    const token = yield* readToken(parsed, environment);
    if (Option.isNone(token) || token.value.length === 0) {
      return failure(2, parsed.json, { _tag: "MissingCapability", tokenEnv: TOKEN_ENV });
    }
    // A signal wins the race as a failure value; a reply as a success.
    const reply = yield* Effect.raceFirst(
      Effect.map(exchange(parsed, token.value), Result.succeed),
      Effect.map(awaitInterrupt(Option.fromNullishOr(environment.interrupt)), Result.fail),
    );
    return Result.match(reply, {
      onSuccess: (response) => render(parsed, response),
      onFailure: (signal) =>
        failure(exitCodeOf(signal), parsed.json, { _tag: "Interrupted", signal }),
    });
  }).pipe(
    Effect.catchTag("Failed", (failed) => Effect.succeed(failure(1, parsed.json, failed.error))),
  );

/** Run one reader command. It never fails and never exits the process. */
export const run = (
  argv: ReadonlyArray<string>,
  environment: CliEnvironment = {},
): Effect.Effect<CliResult> =>
  parse(argv).pipe(
    Effect.flatMap((parsed) => execute(parsed, environment)),
    Effect.catchTags({
      Help: () => Effect.succeed(result(0, HELP, "")),
      // Arguments failed to parse, so only the raw argv says whether --json was asked.
      Invalid: (error) =>
        Effect.succeed(
          failure(
            2,
            argv.includes("--json"),
            { _tag: "InvalidArguments", message: error.message },
            `error: ${error.message}\n\n${HELP}`,
          ),
        ),
    }),
  );
