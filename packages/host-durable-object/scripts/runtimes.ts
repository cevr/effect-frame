/**
 * Picks the runtime a proof runs against from its arguments:
 * `--runtime=workerd` or `--runtime=celld` (the default, as before workerd).
 */

import { celld } from "./celld-process.js";
import type { Runtime } from "./proof.js";
import { workerd } from "./workerd-process.js";

const runtimes: ReadonlyMap<string, Runtime> = new Map([
  [celld.name, celld],
  [workerd.name, workerd],
]);

export const runtimeFromArgs = (argv: ReadonlyArray<string>): Runtime => {
  const flag = argv.find((arg) => arg.startsWith("--runtime="));
  const name = flag === undefined ? celld.name : flag.slice("--runtime=".length);
  const runtime = runtimes.get(name);
  if (runtime === undefined) {
    throw new Error(`unknown runtime ${name}; use one of ${[...runtimes.keys()].join(", ")}`);
  }
  return runtime;
};
