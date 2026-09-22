/* oxlint-disable effect/noGlobals, effect/noNullish, effect/noTernary -- this module is the reader transport boundary: fetch, AbortSignal, URL, JSON text, and argv parsing. */
/**
 * The CLI-shaped reader. `run` takes argv and an environment and returns the
 * exit code with stdout and stderr text; it never touches the process. A
 * later public executable only wires `process.argv`, the token environment
 * variable, SIGINT, and the streams to this function.
 *
 *   roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
 *   inspect --url <gateway> --root <id|prefix|name> [--json] [--deadline <ms>]
 *           [--token-file <path>] [--max-text <chars>]
 *
 * Exit codes: 0 success, 1 operational failure, 2 invalid arguments,
 * 130 interrupted. Data goes to stdout; diagnostics go to stderr.
 */
import { Effect, Match, Option, Schema } from "effect";
import { Protocol } from "effect-frame/inspection";
import { hasControlCharacter } from "./text.js";

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
  readonly exitCode: 0 | 1 | 2 | 130;
  readonly stdout: string;
  readonly stderr: string;
}

/** Failures the reader detects itself, printed in the same error envelope. */
export const ClientError = Schema.Union([
  Schema.TaggedStruct("GatewayUnreachable", { url: Schema.String }),
  Schema.TaggedStruct("GatewayTimedOut", { deadlineMillis: Schema.Int }),
  Schema.TaggedStruct("MalformedResponse", { status: Schema.Int, detail: Schema.String }),
]);
export type ClientError = Schema.Schema.Type<typeof ClientError>;

export const HELP = `effect-frame inspection reader (private proof)

Usage:
  roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
  inspect --url <gateway> --root <selector> [--json] [--deadline <ms>]
          [--token-file <path>] [--max-text <chars>]

Flags:
  --url <gateway>      Loopback gateway, for example http://127.0.0.1:4318
  --root <selector>    Exact root ID, unique ID prefix, or exact root name
  --json               Print one versioned JSON response on stdout
  --deadline <ms>      Finite deadline, 1..${Protocol.MAX_DEADLINE_MILLIS} (default ${Protocol.DEFAULT_DEADLINE_MILLIS})
  --token-file <path>  Read capability file (else ${TOKEN_ENV})
  --max-text <chars>   Longest value shown in text output (default 160)
  -h, --help           Show this help

Examples:
  roots --url http://127.0.0.1:4318 --json
  inspect --url http://127.0.0.1:4318 --root frame-root-3f2a --json

Exit codes: 0 ok, 1 failure, 2 invalid arguments, 130 interrupted.
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
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

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

const readRoot = (command: Parsed["command"], root: Option.Option<string>) =>
  Effect.gen(function* () {
    if (command === "inspect" && Option.isNone(root)) {
      return yield* invalid(
        "inspect needs --root <selector>; list roots with: roots --url <gateway>",
      );
    }
    if (command === "roots" && Option.isSome(root)) return yield* invalid("roots takes no --root");
    const bad = Option.exists(
      root,
      (selector) =>
        selector.length > Protocol.MAX_SELECTOR_LENGTH ||
        hasControlCharacter(selector) ||
        /[?#%]/.test(selector),
    );
    if (bad) return yield* invalid("--root has control characters, ?, #, %, or is too long");
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
    Protocol.DEFAULT_DEADLINE_MILLIS,
    Protocol.MAX_DEADLINE_MILLIS,
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

const rootsText = (response: Protocol.RootsResponse): string =>
  response.roots.length === 0
    ? "no roots attached\n"
    : `${response.roots.map(rootLine).join("\n")}\n`;

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
  return `${lines.join("\n")}\n`;
};

/** Whether an automatic sequence runs now; a command is never shown with its payload. */
const runningText = (running: boolean): string => {
  if (running) return "running";
  return "idle";
};

const errorText = (error: { readonly _tag: string }): string => {
  const detail = JSON.stringify(error);
  switch (error._tag) {
    case "AmbiguousRoot":
      return `error: the selector matches several roots; pass an exact --root\n${detail}\n`;
    case "RootNotFound":
      return `error: no attached root matches; list roots with: roots --url <gateway>\n${detail}\n`;
    case "Unauthorized":
      return `error: the gateway refused the capability; check --token-file or ${TOKEN_ENV}\n`;
    default:
      return `error: ${error._tag}\n${detail}\n`;
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
    [Protocol.VERSION_HEADER]: String(Protocol.PROTOCOL_VERSION),
    "content-type": "application/json",
  };
  if (parsed.command === "roots") return { method: "GET", headers };
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: Protocol.PROTOCOL_VERSION,
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
      parsed.command === "roots" ? Protocol.ROOTS_PATH : Protocol.INSPECT_PATH,
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
  Option.match(signal, {
    onNone: () => Effect.never,
    onSome: (abort) =>
      Effect.callback<void>((resume) => {
        if (abort.aborted) {
          resume(Effect.void);
          return;
        }
        const onAbort = () => resume(Effect.void);
        abort.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => abort.removeEventListener("abort", onAbort));
      }),
  });

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

const execute = (parsed: Parsed, environment: CliEnvironment) =>
  Effect.gen(function* () {
    const token = yield* readToken(parsed, environment);
    if (Option.isNone(token) || token.value.length === 0) {
      return result(
        2,
        "",
        `error: no read capability; pass --token-file <path> or set ${TOKEN_ENV}\n`,
      );
    }
    const interrupted = Symbol("interrupted");
    const reply = yield* Effect.raceFirst(
      exchange(parsed, token.value),
      Effect.as(awaitInterrupt(Option.fromNullishOr(environment.interrupt)), interrupted),
    );
    if (reply === interrupted) return result(130, "", "interrupted\n");
    return render(parsed, reply);
  }).pipe(
    Effect.catchTag("Failed", (failed) => {
      const error = failed.error;
      const body = { _tag: "Error", version: Protocol.PROTOCOL_VERSION, error };
      return Effect.succeed(
        result(1, parsed.json ? `${JSON.stringify(body)}\n` : "", errorText(error)),
      );
    }),
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
      Invalid: (error) => Effect.succeed(result(2, "", `error: ${error.message}\n\n${HELP}`)),
    }),
  );
