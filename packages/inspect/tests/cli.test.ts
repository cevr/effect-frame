/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNodeBuiltinImport, effect/noThrowStatement, effect/noNewError, no-await-in-loop -- this proof runs the real effect-frame executable as a child process and reads its files. */
/**
 * The `effect-frame` executable as a user runs it: a real child process of
 * `src/bin.ts`, real argv, real environment, real signals, real files. It
 * proves the exit codes, that `--json` prints exactly one versioned document
 * for success and failure, that capabilities stay off stdout and argv, and
 * that capability files have mode 0600 and die with the gateway.
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Option, Schema } from "effect";
import * as Reader from "../src/reader.js";

const BIN = resolve(import.meta.dir, "../src/bin.ts");
const ORIGIN = "http://127.0.0.1:9";

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The environment without an inherited capability. */
const baseEnv = () =>
  Object.fromEntries(
    Object.entries(Bun.env).flatMap(([key, value]) =>
      Option.match(
        Option.filter(Option.fromNullishOr(value), () => key !== Reader.TOKEN_ENV),
        {
          onNone: () => [],
          onSome: (present) => [[key, present]],
        },
      ),
    ),
  ) satisfies Record<string, string>;

type Env = ReturnType<typeof baseEnv>;

const command = (args: ReadonlyArray<string>) => ["bun", "--conditions=source", BIN, ...args];

const spawnBin = (args: ReadonlyArray<string>) =>
  Bun.spawn(command(args), { env: baseEnv(), stdout: "pipe", stderr: "pipe" });

/** One short command to completion. */
const run = (args: ReadonlyArray<string>, env: Env = baseEnv()): Run => {
  const child = Bun.spawnSync(command(args), { env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
};

const decodeDocument = Schema.decodeUnknownSync(Schema.fromJsonString(Reader.Document));

/** Stdout holds exactly one valid versioned JSON document on one line. */
const oneDocument = (stdout: string): Reader.Document => {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(1);
  expect(stdout.endsWith("\n")).toBe(true);
  const document = decodeDocument(stdout.trim());
  expect(document.version).toBe(1);
  return document;
};

const errorTag = (stdout: string): string => {
  const document = oneDocument(stdout);
  if (document._tag !== "Error") throw new Error(`expected an error document: ${stdout}`);
  return document.error._tag;
};

interface RunningGateway {
  readonly child: ReturnType<typeof spawnBin>;
  readonly url: string;
  readonly stateDir: string;
  readonly stderr: () => string;
  readonly stdout: () => Promise<string>;
}

/** Start `effect-frame gateway` and wait for its ready text on stderr. */
const startGateway = async (port = "0"): Promise<RunningGateway> => {
  const stateDir = join(await mkdtemp(join(tmpdir(), "effect-frame-inspect-")), "state");
  const child = spawnBin([
    "gateway",
    "--origin",
    `${ORIGIN}/`,
    "--port",
    port,
    "--state-dir",
    stateDir,
  ]);
  let stderr = "";
  const decoder = new TextDecoder();
  const reader = child.stderr.getReader();
  const until = performance.now() + 10_000;
  while (!stderr.includes("stop with:") && performance.now() < until) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stderr += decoder.decode(chunk.value, { stream: true });
  }
  const url = Option.getOrThrowWith(
    Option.flatMap(
      Option.fromNullishOr(/reader url\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stderr)),
      (match) => Option.fromNullishOr(match[1]),
    ),
    () => new Error(`gateway did not start:\n${stderr}`),
  );
  // Keep draining stderr so the child never blocks on a full pipe.
  const drained = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      stderr += decoder.decode(chunk.value, { stream: true });
    }
  })();
  return {
    child,
    url,
    stateDir,
    stderr: () => stderr,
    stdout: async () => {
      await drained;
      return new Response(child.stdout).text();
    },
  };
};

describe("effect-frame executable", () => {
  it("exits 2 on an empty invocation and 0 for help", async () => {
    const empty = run([]);
    expect(empty.exitCode).toBe(2);
    expect(empty.stdout).toBe("");
    expect(empty.stderr).toContain("missing command");
    expect(empty.stderr).toContain("effect-frame gateway --origin");

    const help = run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("effect-frame inspect --url");
    expect(help.stderr).toBe("");

    const gatewayHelp = run(["gateway", "--help"]);
    expect(gatewayHelp.exitCode).toBe(0);
    expect(gatewayHelp.stdout).toContain("mode 0600");

    const readerHelp = run(["inspect", "--help"]);
    expect(readerHelp.exitCode).toBe(0);
    expect(readerHelp.stdout).toContain("--token-file");
  }, 30_000);

  it("exits 2 with one JSON document for misuse, and takes no capability as a flag", async () => {
    const unknown = run(["watch", "--json"]);
    expect(unknown.exitCode).toBe(2);
    expect(errorTag(unknown.stdout)).toBe("InvalidArguments");

    const tokenFlag = run(["roots", "--url", "http://127.0.0.1:1", "--token", "x", "--json"]);
    expect(tokenFlag.exitCode).toBe(2);
    expect(errorTag(tokenFlag.stdout)).toBe("InvalidArguments");

    const deadline = run([
      "inspect",
      "--url",
      "http://127.0.0.1:1",
      "--root",
      "x",
      "--deadline",
      "30001",
      "--json",
    ]);
    expect(deadline.exitCode).toBe(2);
    expect(errorTag(deadline.stdout)).toBe("InvalidArguments");

    const noRoot = run(["inspect", "--url", "http://127.0.0.1:1"]);
    expect(noRoot.exitCode).toBe(2);
    expect(noRoot.stdout).toBe("");

    const remote = run(["roots", "--url", "http://example.com:80", "--json"]);
    expect(remote.exitCode).toBe(2);
    expect(errorTag(remote.stdout)).toBe("InvalidArguments");

    const origin = run(["gateway", "--origin", "http://localhost:5173/app"]);
    expect(origin.exitCode).toBe(2);
    expect(origin.stderr).toContain("--origin must be an http(s) origin with no path");

    const port = run(["gateway", "--origin", ORIGIN, "--port", "70000"]);
    expect(port.exitCode).toBe(2);
  }, 30_000);

  it("exits 1 with one JSON document when the gateway is unreachable", async () => {
    const env = { ...baseEnv(), [Reader.TOKEN_ENV]: "read-capability-for-a-dead-port" };
    const unreachable = run(["roots", "--url", "http://127.0.0.1:1", "--json"], env);
    expect(unreachable.exitCode).toBe(1);
    expect(errorTag(unreachable.stdout)).toBe("GatewayUnreachable");
  }, 30_000);

  it("serves readers with capability files of mode 0600 and removes them on SIGINT", async () => {
    const gateway = await startGateway();
    const attachFile = join(gateway.stateDir, "attach-token");
    const readFile_ = join(gateway.stateDir, "read-token");
    const checks = async () => {
      for (const file of [attachFile, readFile_]) {
        expect({ file, mode: (await stat(file)).mode & 0o777 }).toEqual({ file, mode: 0o600 });
      }
      const attachToken = (await readFile(attachFile, "utf8")).trim();
      const readToken = (await readFile(readFile_, "utf8")).trim();
      expect(attachToken).toMatch(/^[0-9a-f]{64}$/);
      expect(readToken).toMatch(/^[0-9a-f]{64}$/);
      expect(attachToken).not.toBe(readToken);
      // Paths are printed; capabilities are not.
      expect(gateway.stderr()).toContain(readFile_);
      expect(gateway.stderr().includes(readToken)).toBe(false);
      expect(gateway.stderr().includes(attachToken)).toBe(false);

      const roots = run(["roots", "--url", gateway.url, "--token-file", readFile_, "--json"]);
      expect(roots.exitCode).toBe(0);
      expect(oneDocument(roots.stdout)).toEqual({ _tag: "Roots", version: 1, roots: [] });

      const fromEnv = run(["roots", "--url", gateway.url], {
        ...baseEnv(),
        [Reader.TOKEN_ENV]: readToken,
      });
      expect(fromEnv.exitCode).toBe(0);
      expect(fromEnv.stdout).toBe("no roots attached\n");

      const missing = run(["inspect", "--url", gateway.url, "--root", "nope", "--json"], {
        ...baseEnv(),
        [Reader.TOKEN_ENV]: readToken,
      });
      expect(missing.exitCode).toBe(1);
      expect(errorTag(missing.stdout)).toBe("RootNotFound");

      const noCapability = run(["roots", "--url", gateway.url, "--json"]);
      expect(noCapability.exitCode).toBe(2);
      expect(errorTag(noCapability.stdout)).toBe("MissingCapability");

      const wrongCapability = run([
        "roots",
        "--url",
        gateway.url,
        "--token-file",
        attachFile,
        "--json",
      ]);
      expect(wrongCapability.exitCode).toBe(1);
      expect(errorTag(wrongCapability.stdout)).toBe("Unauthorized");

      // A second gateway on the same port cannot listen.
      const port = new URL(gateway.url).port;
      const clash = run([
        "gateway",
        "--origin",
        ORIGIN,
        "--port",
        port,
        "--state-dir",
        join(gateway.stateDir, "other"),
      ]);
      expect(clash.exitCode).toBe(1);
      expect(clash.stderr).toContain(`could not listen on port ${port}`);
    };
    // Stop the gateway whether or not a check failed.
    await checks().finally(() => gateway.child.kill("SIGINT"));
    expect(await gateway.child.exited).toBe(130);
    expect(await gateway.stdout()).toBe("");
    expect(gateway.stderr()).toContain("effect-frame gateway stopped");
    for (const file of [attachFile, readFile_]) {
      expect(await Bun.file(file).exists()).toBe(false);
    }
  }, 30_000);
});
