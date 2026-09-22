/* oxlint-disable effect/noGlobals, effect/noNullish -- this module is the argv boundary of the effect-frame executable: URL parsing, AbortSignal, and raw argv. */
/**
 * The `effect-frame` executable's commands.
 *
 *   effect-frame gateway --origin <app origin> [--port <n>] [--state-dir <dir>]
 *   effect-frame roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
 *   effect-frame inspect --url <gateway> --root <id|prefix|name> [--json]
 *                        [--deadline <ms>] [--token-file <path>] [--max-text <n>]
 *
 * `main` never touches the process. `bin.ts` supplies argv, the token
 * variable, the default state directory, SIGINT, and the streams, and exits
 * with the code `main` returns.
 */
import { Effect, Option, Schema } from "effect";
import { Protocol } from "effect-frame/inspection";
import * as Capabilities from "./capabilities.js";
import * as Gateway from "./gateway.js";
import * as Reader from "./reader.js";

export type ExitCode = 0 | 1 | 2 | 130;

export interface Io {
  readonly argv: ReadonlyArray<string>;
  /** The value of `EFFECT_FRAME_INSPECT_TOKEN`, when set. */
  readonly token: Option.Option<string>;
  /** Where `gateway` writes capability files when `--state-dir` is absent. */
  readonly defaultStateDir: string;
  /** Aborts the running command as SIGINT does. */
  readonly interrupt: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const DEFAULT_PORT = 4318;

const INTERRUPTED: ExitCode = 130;

export const HELP = `effect-frame: inspect live effect-frame roots.

Usage:
  effect-frame gateway --origin <app origin> [--port <n>] [--state-dir <dir>]
  effect-frame roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
  effect-frame inspect --url <gateway> --root <id|prefix|name> [--json]
                       [--deadline <ms>] [--token-file <path>] [--max-text <n>]

Run 'effect-frame <command> --help' for the flags of one command.

Exit codes: 0 ok, 1 failure, 2 invalid arguments or no capability, 130 interrupted.
`;

export const GATEWAY_HELP = `Start a loopback inspection gateway for one application origin.

Usage:
  effect-frame gateway --origin <app origin> [--port <n>] [--state-dir <dir>]

Flags:
  --origin <origin>    The one application origin allowed to attach roots,
                       for example http://localhost:5173
  --port <n>           Loopback port, 0 for an ephemeral port (default ${DEFAULT_PORT})
  --state-dir <dir>    Where the capability files go (default: $XDG_STATE_HOME/effect-frame/inspect)
  -h, --help           Show this help

The gateway writes '${Capabilities.ATTACH_TOKEN_FILE}' and '${Capabilities.READ_TOKEN_FILE}' with mode 0600
into the state directory and prints their paths on stderr. It never prints a
capability on stdout. It removes both files when it stops. Stop it with Ctrl-C.

Exit codes: 1 listen or file failure, 2 invalid arguments, 130 interrupted.
`;

// ---------------------------------------------------------------------------
// gateway arguments
// ---------------------------------------------------------------------------

interface GatewayArgs {
  readonly origin: string;
  readonly port: number;
  readonly stateDir: string;
}

class Invalid extends Schema.TaggedError<Invalid>()("Invalid", { message: Schema.String }) {}
class Help extends Schema.TaggedError<Help>()("Help", {}) {}

const invalid = (message: string) => Effect.fail(Invalid.make({ message }));

const GATEWAY_FLAGS = new Set(["--origin", "--port", "--state-dir"]);

const readGatewayFlags = Effect.fn("InspectCli.readGatewayFlags")(function* (
  rest: ReadonlyArray<string>,
) {
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? "";
    if (!GATEWAY_FLAGS.has(flag)) return yield* invalid(`unknown flag '${flag.slice(0, 32)}'`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return yield* invalid(`${flag} needs a value`);
    }
    if (values.has(flag)) return yield* invalid(`${flag} given twice`);
    values.set(flag, value);
    index += 1;
  }
  return values;
});

/** The exact browser `Origin` value: scheme, host, and port, and nothing else. */
const readOrigin = (raw: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(raw)) return yield* invalid("--origin is required");
    const url = yield* Effect.try({
      try: () => new URL(raw.value),
      catch: () => Invalid.make({ message: "--origin does not parse" }),
    });
    const bare =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "";
    if (!bare) return yield* invalid("--origin must be an http(s) origin with no path");
    return url.origin;
  });

const readPort = (raw: Option.Option<string>) =>
  Option.match(raw, {
    onNone: () => Effect.succeed(DEFAULT_PORT),
    onSome: (value) => {
      if (/^[0-9]{1,5}$/.test(value) && Number(value) <= 65_535) {
        return Effect.succeed(Number(value));
      }
      return invalid("--port must be an integer from 0 to 65535");
    },
  });

const parseGateway = Effect.fn("InspectCli.parseGateway")(function* (
  rest: ReadonlyArray<string>,
  io: Io,
) {
  if (rest.includes("--help") || rest.includes("-h")) return yield* Help.make({});
  const values = yield* readGatewayFlags(rest);
  const origin = yield* readOrigin(Option.fromNullishOr(values.get("--origin")));
  const port = yield* readPort(Option.fromNullishOr(values.get("--port")));
  const stateDir = Option.getOrElse(
    Option.fromNullishOr(values.get("--state-dir")),
    () => io.defaultStateDir,
  );
  if (stateDir.length === 0) return yield* invalid("--state-dir must not be empty");
  return { origin, port, stateDir } satisfies GatewayArgs;
});

// ---------------------------------------------------------------------------
// gateway
// ---------------------------------------------------------------------------

const untilInterrupted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const readyText = (
  args: GatewayArgs,
  gateway: Gateway.Gateway,
  files: Capabilities.CapabilityFiles,
) =>
  [
    "effect-frame gateway is listening",
    `  origin        ${args.origin}`,
    `  attach url    ${gateway.attachUrl}`,
    `  reader url    ${gateway.url}`,
    `  attach token  ${files.attach}`,
    `  read token    ${files.read}`,
    "",
    `read with: effect-frame roots --url ${gateway.url} --token-file ${files.read}`,
    "stop with: Ctrl-C",
    "",
  ].join("\n");

const serve = (args: GatewayArgs, io: Io): Effect.Effect<ExitCode> =>
  Effect.gen(function* () {
    const tokens = { attach: Gateway.makeToken(), read: Gateway.makeToken() };
    const gateway = yield* Gateway.make({
      allowedOrigin: args.origin,
      attachToken: tokens.attach,
      readToken: tokens.read,
      port: args.port,
    });
    const files = yield* Capabilities.write(args.stateDir, tokens);
    io.stderr(readyText(args, gateway, files));
    yield* untilInterrupted(io.interrupt);
    io.stderr("effect-frame gateway stopped\n");
    return INTERRUPTED;
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      GatewayListenError: (error) =>
        Effect.sync((): ExitCode => {
          io.stderr(`error: the gateway could not listen on port ${error.port}: ${error.detail}\n`);
          return 1;
        }),
      CapabilityFileError: (error) =>
        Effect.sync((): ExitCode => {
          io.stderr(`error: ${error.detail}: ${error.path}\n`);
          return 1;
        }),
    }),
  );

const gateway = (rest: ReadonlyArray<string>, io: Io): Effect.Effect<ExitCode> =>
  parseGateway(rest, io).pipe(
    Effect.flatMap((args) => serve(args, io)),
    Effect.catchTags({
      Help: () =>
        Effect.sync((): ExitCode => {
          io.stdout(GATEWAY_HELP);
          return 0;
        }),
      Invalid: (error) =>
        Effect.sync((): ExitCode => {
          io.stderr(`error: ${error.message}\n\n${GATEWAY_HELP}`);
          return 2;
        }),
    }),
  );

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const reader = (io: Io): Effect.Effect<ExitCode> =>
  Reader.run(io.argv, {
    ...Option.match(io.token, { onNone: () => ({}), onSome: (token) => ({ token }) }),
    interrupt: io.interrupt,
  }).pipe(
    Effect.map((result) => {
      io.stdout(result.stdout);
      io.stderr(result.stderr);
      return result.exitCode;
    }),
  );

const misuse = (io: Io, message: string): Effect.Effect<ExitCode> =>
  Effect.sync((): ExitCode => {
    if (io.argv.includes("--json")) {
      io.stdout(
        `${JSON.stringify({ _tag: "Error", version: Protocol.PROTOCOL_VERSION, error: { _tag: "InvalidArguments", message } })}\n`,
      );
    }
    io.stderr(`error: ${message}\n\n${HELP}`);
    return 2;
  });

/** Run one invocation of the executable and return its exit code. */
export const main = (io: Io): Effect.Effect<ExitCode> => {
  const [command, ...rest] = io.argv;
  if (command === undefined) return misuse(io, "missing command");
  if (command === "--help" || command === "-h" || command === "help") {
    return Effect.sync((): ExitCode => {
      io.stdout(HELP);
      return 0;
    });
  }
  if (command === "gateway") return gateway(rest, io);
  if (command === "roots" || command === "inspect") return reader(io);
  return misuse(
    io,
    `unknown command '${command.slice(0, 32)}'; expected gateway, roots, or inspect`,
  );
};
