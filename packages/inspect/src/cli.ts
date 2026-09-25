/* oxlint-disable effect/noNullish -- this module is the argv boundary of the effect-frame executable: raw argv reads undefined past its end. */
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
import { Effect, Option } from "effect";
import * as Capabilities from "./capabilities.js";
import { Help, Invalid, invalid, readFlags, type FlagSpec } from "./flags.js";
import * as Gateway from "./gateway.js";
import * as Reader from "./reader.js";
import { exitCodeOf, untilInterrupted, type ExitCode } from "./signals.js";

export type { ExitCode } from "./signals.js";

export interface Io {
  readonly argv: ReadonlyArray<string>;
  /** The value of `EFFECT_FRAME_INSPECT_TOKEN`, when set. */
  readonly token: Option.Option<string>;
  /** `HOME`, when set. */
  readonly home: Option.Option<string>;
  /** `XDG_STATE_HOME`, when set. */
  readonly xdgStateHome: Option.Option<string>;
  /** This process's PID; it owns the gateway lock. */
  readonly pid: number;
  /** Aborted with `SIGINT`, `SIGTERM`, or `SIGHUP` as its reason. */
  readonly interrupt: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const DEFAULT_PORT = 4318;

export const HELP = `effect-frame: inspect live effect-frame roots.

Usage:
  effect-frame gateway --origin <app origin> [--port <n>] [--state-dir <dir>]
  effect-frame roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
  effect-frame inspect --url <gateway> --root <id|prefix|name> [--json]
                       [--deadline <ms>] [--token-file <path>] [--max-text <n>]

Run 'effect-frame <command> --help' for the flags of one command.

Exit codes: 0 ok, 1 failure, 2 invalid arguments or no capability,
130/143/129 stopped by SIGINT/SIGTERM/SIGHUP.
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

The state directory must belong to you; the gateway sets its mode to 0700.
One gateway owns it at a time through '${Capabilities.LOCK_FILE}'. The gateway writes
'${Capabilities.ATTACH_TOKEN_FILE}' and '${Capabilities.READ_TOKEN_FILE}' with mode 0600 and prints their paths on
stderr. It never prints a capability on stdout. It removes both files when
it stops. Stop it with Ctrl-C, SIGTERM, or SIGHUP.

Exit codes: 1 listen, directory, or file failure, 2 invalid arguments or no
usable default state directory, 130/143/129 stopped by SIGINT/SIGTERM/SIGHUP.
`;

// ---------------------------------------------------------------------------
// gateway arguments
// ---------------------------------------------------------------------------

interface GatewayArgs {
  readonly origin: string;
  readonly port: number;
  readonly stateDir: string;
}

const GATEWAY_FLAGS: FlagSpec = {
  values: new Set(["--origin", "--port", "--state-dir"]),
  switches: new Set(),
};

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

const present = (value: Option.Option<string>) => Option.filter(value, (text) => text.length > 0);

/**
 * `$XDG_STATE_HOME/effect-frame/inspect`, else
 * `$HOME/.local/state/effect-frame/inspect`. A relative `XDG_STATE_HOME` or a
 * missing `HOME` is a usage error, not a guess.
 */
const defaultStateDir = (io: Io) =>
  Option.match(present(io.xdgStateHome), {
    onSome: (dir) => {
      if (!dir.startsWith("/")) return invalid("XDG_STATE_HOME must be an absolute path");
      return Effect.succeed(`${dir}/effect-frame/inspect`);
    },
    onNone: () =>
      Option.match(present(io.home), {
        onNone: () => invalid("HOME is not set; pass --state-dir or set XDG_STATE_HOME"),
        onSome: (home) => {
          if (!home.startsWith("/")) return invalid("HOME must be an absolute path");
          return Effect.succeed(`${home}/.local/state/effect-frame/inspect`);
        },
      }),
  });

const parseGateway = Effect.fn("InspectCli.parseGateway")(function* (
  rest: ReadonlyArray<string>,
  io: Io,
) {
  if (rest.includes("--help") || rest.includes("-h")) return yield* Help.make({});
  const { values } = yield* readFlags(rest, GATEWAY_FLAGS);
  const origin = yield* readOrigin(Option.fromNullishOr(values.get("--origin")));
  const port = yield* readPort(Option.fromNullishOr(values.get("--port")));
  const stateDir = yield* Option.match(Option.fromNullishOr(values.get("--state-dir")), {
    onNone: () => defaultStateDir(io),
    onSome: (dir) => Effect.succeed(dir),
  });
  if (stateDir.length === 0) return yield* invalid("--state-dir must not be empty");
  return { origin, port, stateDir } satisfies GatewayArgs;
});

// ---------------------------------------------------------------------------
// gateway
// ---------------------------------------------------------------------------

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
    "stop with: Ctrl-C, SIGTERM, or SIGHUP",
    "",
  ].join("\n");

const serve = (args: GatewayArgs, io: Io): Effect.Effect<ExitCode> =>
  Effect.gen(function* () {
    // Own the directory before anything else, so a second gateway never
    // overwrites the first one's capabilities.
    yield* Capabilities.prepareDirectory(args.stateDir);
    yield* Capabilities.lock(args.stateDir, io.pid);
    const tokens = { attach: Gateway.makeToken(), read: Gateway.makeToken() };
    const gateway = yield* Gateway.make({
      allowedOrigin: args.origin,
      attachToken: tokens.attach,
      readToken: tokens.read,
      port: args.port,
      maxSnapshotBytes: Gateway.defaultMaxSnapshotBytes,
      maxRoots: Gateway.defaultMaxRoots,
    });
    const files = yield* Capabilities.write(args.stateDir, tokens);
    io.stderr(readyText(args, gateway, files));
    const signal = yield* untilInterrupted(io.interrupt);
    return exitCodeOf(signal);
  }).pipe(
    Effect.scoped,
    // The scope is closed here: the capability files and the lock are gone.
    Effect.tap(() => Effect.sync(() => io.stderr("effect-frame gateway stopped\n"))),
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
      StateDirectoryInUse: (error) =>
        Effect.sync((): ExitCode => {
          io.stderr(
            `error: another effect-frame gateway (pid ${error.pid}) owns ${error.directory}; stop it or pass another --state-dir\n`,
          );
          return 1;
        }),
      StateDirectoryRefused: (error) =>
        Effect.sync((): ExitCode => {
          io.stderr(`error: refusing state directory ${error.directory}: ${error.detail}\n`);
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
      io.stdout(Reader.errorDocument({ _tag: "InvalidArguments", message }));
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
