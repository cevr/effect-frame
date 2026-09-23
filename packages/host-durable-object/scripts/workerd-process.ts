/**
 * The workerd runtime for the recovery proofs and the conformance test.
 *
 * It runs Cloudflare's open-source Workers runtime, the same `workerd` build
 * Alchemy 2.0.0-beta.79 runs for local development (its
 * `@alchemy.run/cloudflare-runtime` pins `workerd` 1.20260901.1). Like
 * Alchemy, it drives the binary directly: no Wrangler, no Miniflare, and no
 * account.
 *
 * The fixture's `wrangler.jsonc` is the one description of the worker. This
 * file derives the workerd config from it: the module, the compatibility
 * date, one Durable Object namespace per binding, and SQLite storage for
 * every class a `new_sqlite_classes` migration names. Object storage lives on
 * disk at `<projectDir>/.workerd`, so a SIGKILL loses the process and keeps
 * the objects and their alarms.
 *
 * This is a test runner, not library code. It uses plain promises and the
 * process APIs a runner needs.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Schema } from "effect";
import workerdBin from "workerd";
import type { SqlRow } from "../src/storage.js";
import type { Node, Runtime } from "./proof.js";
import { exited, sleep } from "./proof.js";

export { workerdBin };

/** The parts of a `wrangler.jsonc` this runtime reads. */
const Wrangler = Schema.Struct({
  name: Schema.String,
  main: Schema.String,
  compatibility_date: Schema.String,
  compatibility_flags: Schema.optional(Schema.Array(Schema.String)),
  durable_objects: Schema.Struct({
    bindings: Schema.Array(Schema.Struct({ name: Schema.String, class_name: Schema.String })),
  }),
  migrations: Schema.Array(
    Schema.Struct({ new_sqlite_classes: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});
type Wrangler = Schema.Schema.Type<typeof Wrangler>;

const decodeWrangler = Schema.decodeUnknownSync(Wrangler);

const readWrangler = (projectDir: string): Wrangler =>
  decodeWrangler(Bun.JSONC.parse(readFileSync(join(projectDir, "wrangler.jsonc"), "utf8")));

/** A Cap'n Proto text string. Its escapes match JSON's for these values. */
const text = (value: string): string => JSON.stringify(value);

/** The workerd config that serves the fixture the way Cloudflare would. */
export const workerdConfig = (wrangler: Wrangler, port: number, storageDir: string): string => {
  const sqlite = new Set(wrangler.migrations.flatMap((step) => step.new_sqlite_classes ?? []));
  const classes = [...new Set(wrangler.durable_objects.bindings.map((b) => b.class_name))];
  const namespaces = classes
    .map(
      (className) =>
        `(className = ${text(className)}, uniqueKey = ${text(`${wrangler.name}-${className}`)}, enableSql = ${sqlite.has(className)})`,
    )
    .join(", ");
  const bindings = wrangler.durable_objects.bindings
    .map(
      (binding) =>
        `(name = ${text(binding.name)}, durableObjectNamespace = ${text(binding.class_name)})`,
    )
    .join(", ");
  const flags = (wrangler.compatibility_flags ?? []).map(text).join(", ");
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "storage", disk = (path = ${text(storageDir)}, writable = true)),
  ],
  sockets = [(name = "http", address = ${text(`127.0.0.1:${port}`)}, http = (), service = "main")],
);

const worker :Workerd.Worker = (
  modules = [(name = ${text(wrangler.main)}, esModule = embed ${text(wrangler.main)})],
  compatibilityDate = ${text(wrangler.compatibility_date)},
  compatibilityFlags = [${flags}],
  durableObjectNamespaces = [${namespaces}],
  durableObjectStorage = (localDisk = "storage"),
  bindings = [${bindings}],
);
`;
};

/**
 * Resolves once workerd reports on its control descriptor that the socket
 * listens. This is the signal Alchemy waits for too.
 */
const listening = (control: Readable, launcher: ChildProcess, logs: Array<string>) =>
  new Promise<void>((done, failed) => {
    let buffered = "";
    const timer = setTimeout(() => {
      failed(new Error(`workerd never listened:\n${logs.join("")}`));
    }, 30_000);
    control.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.includes('"event":"listen"')) {
        clearTimeout(timer);
        done();
      }
    });
    launcher.on("exit", (code, signal) => {
      clearTimeout(timer);
      failed(new Error(`workerd exited early (${code ?? signal}):\n${logs.join("")}`));
    });
  });

const kill = async (launcher: ChildProcess): Promise<void> => {
  launcher.kill("SIGKILL");
  await Promise.race([exited(launcher), sleep(5000)]);
};

/** Starts workerd over the directory and resolves once its socket listens. */
const start = async (projectDir: string, port: number): Promise<Node> => {
  const storageDir = join(projectDir, ".workerd");
  mkdirSync(storageDir, { recursive: true });
  const configPath = join(projectDir, "workerd.capnp");
  writeFileSync(configPath, workerdConfig(readWrangler(projectDir), port, storageDir));

  const logs: Array<string> = [];
  const launcher = spawn(workerdBin, ["serve", "--control-fd=3", configPath], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer): void => {
    logs.push(chunk.toString());
  };
  launcher.stdout?.on("data", collect);
  launcher.stderr?.on("data", collect);
  const control = launcher.stdio[3];
  if (!(control instanceof Readable)) {
    await kill(launcher);
    throw new Error("workerd has no control descriptor");
  }
  await listening(control, launcher, logs);
  return {
    port,
    logs,
    // workerd is one process: SIGKILL on it is the whole runtime lost.
    crash: () => kill(launcher),
    stop: () => kill(launcher),
  } satisfies Node;
};

/**
 * workerd keeps one SQLite file per object at
 * `<storage>/<uniqueKey>/<object id>.sqlite`, beside a `metadata.sqlite` that
 * holds the alarms. This reads every object file read-only.
 */
const readObjects = (projectDir: string, query: string): ReadonlyArray<SqlRow> => {
  const storageDir = join(projectDir, ".workerd");
  return readdirSync(storageDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((namespace) =>
      readdirSync(join(storageDir, namespace.name))
        .filter((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite")
        .map((file) => join(storageDir, namespace.name, file)),
    )
    .flatMap((path) => {
      const database = new Database(path, { readonly: true });
      try {
        const hasCommands =
          database
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'commands'")
            .all().length > 0;
        return hasCommands ? database.query<SqlRow, []>(query).all() : [];
      } finally {
        database.close();
      }
    });
};

export const workerd: Runtime = {
  name: "workerd",
  describe: `workerd binary ${workerdBin}`,
  start,
  readObjects,
};
