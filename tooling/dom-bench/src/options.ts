import { Schema } from "effect";

export const FrameworkSchema = Schema.Literals(["effect-frame", "solid2", "octane"]);
export const EngineSchema = Schema.Literals(["chrome", "webkit"]);
export const OperationNameSchema = Schema.Literals([
  "create-1k",
  "replace-1k",
  "update-10th-10k",
  "select-1k",
  "swap-1k",
  "remove-1k",
  "create-10k",
  "append-10k",
  "clear-10k",
]);

export type FrameworkName = Schema.Schema.Type<typeof FrameworkSchema>;
export type EngineName = Schema.Schema.Type<typeof EngineSchema>;
export type OperationName = Schema.Schema.Type<typeof OperationNameSchema>;

interface BenchOptions {
  readonly help: boolean;
  readonly framework: FrameworkName;
  readonly engines: ReadonlyArray<EngineName>;
  readonly count: number;
  readonly official: boolean;
  readonly only?: OperationName;
}

const officialBenchmarkIdByOperation = {
  "create-1k": "01_",
  "replace-1k": "02_",
  "update-10th-10k": "03_",
  "select-1k": "04_",
  "swap-1k": "05_",
  "remove-1k": "06_",
  "create-10k": "07_",
  "append-10k": "08_",
  "clear-10k": "09_",
} satisfies Readonly<Record<OperationName, string>>;

/** krausest benchmark id prefixes for one operation, or for every CPU operation when none is named. */
export const officialBenchmarkIds = (
  // oxlint-disable-next-line effect/noNullish -- the optional --only flag is a CLI boundary.
  operation: OperationName | undefined,
): ReadonlyArray<string> =>
  // oxlint-disable-next-line effect/noNullish, effect/noTernary -- an absent --only selects every official workload.
  operation === undefined
    ? Object.values(officialBenchmarkIdByOperation)
    : [officialBenchmarkIdByOperation[operation]];

export const helpText = `Usage: bun run bench -- [options]

Options:
  --framework <name>  effect-frame, solid2, or octane (default: effect-frame)
  --engine <name>     chrome or webkit (default: both)
  --count <number>    samples per cell, from 1 to 100 (default: 1)
  --only <operation>  run one operation
  --official          run the pinned krausest Playwright runner (every workload, or --only)
  -h, --help          show this help without starting a benchmark
`;

const invalid = (message: string): never => {
  // oxlint-disable-next-line effect/noNewError, effect/noThrowStatement -- CLI parse failures cross the main process boundary.
  throw new Error(`invalid benchmark options: ${message}`);
};

// oxlint-disable-next-line effect/noUnknownParameters -- this is the error boundary for parser failures.
export const isInvalidOptionsError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith("invalid benchmark options:");

const requireValue = (argv: ReadonlyArray<string>, index: number, option: string): string => {
  const value = argv[index + 1];
  // oxlint-disable-next-line effect/noNullish -- missing option values are a CLI parse failure.
  if (value === undefined) return invalid(`${option} requires a value`);
  if (value.startsWith("--")) return invalid(`${option} requires a value`);
  return value;
};

const requireFramework = (value: string, option: string): FrameworkName => {
  if (Schema.is(FrameworkSchema)(value)) return value;
  return invalid(`${option} must be one of effect-frame, solid2, or octane; received ${value}`);
};

const requireEngine = (value: string): EngineName => {
  if (Schema.is(EngineSchema)(value)) return value;
  return invalid(`--engine must be chrome or webkit; received ${value}`);
};

const requireOperation = (value: string): OperationName => {
  if (Schema.is(OperationNameSchema)(value)) return value;
  return invalid(`--only received unknown operation ${value}`);
};

const requireCount = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return invalid(`--count must be an integer from 1 to 100; received ${value}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > 100) {
    return invalid(`--count must be an integer from 1 to 100; received ${value}`);
  }
  return count;
};

export const parseOptions = (argv: ReadonlyArray<string>): BenchOptions => {
  let framework: FrameworkName = "effect-frame";
  let engines: ReadonlyArray<EngineName> = ["chrome", "webkit"];
  let count = 1;
  let official = false;
  // oxlint-disable-next-line effect/noNullish -- the optional --only flag is a CLI boundary.
  let only: OperationName | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // oxlint-disable-next-line effect/noNullish -- a missing argv entry ends iteration safely.
    if (argument === undefined) continue;
    switch (argument) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--framework":
        framework = requireFramework(requireValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--engine":
        engines = [requireEngine(requireValue(argv, index, argument))];
        index += 1;
        break;
      case "--count":
        count = requireCount(requireValue(argv, index, argument));
        index += 1;
        break;
      case "--official":
        official = true;
        break;
      case "--only":
        only = requireOperation(requireValue(argv, index, argument));
        index += 1;
        break;
      default:
        invalid(`unknown option ${argument}`);
    }
  }
  return { help, framework, engines, count, official, only };
};
