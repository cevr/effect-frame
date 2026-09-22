import { describe, expect, it } from "bun:test";
import { officialBenchmarkIds, parseOptions } from "../src/options.js";

describe("benchmark CLI options", () => {
  it("rejects unknown values, missing values, and unknown flags", () => {
    const invalidArguments: ReadonlyArray<ReadonlyArray<string>> = [
      ["--framework", "solidd2"],
      ["--engine", "firefox"],
      ["--only", "typo"],
      ["--count", "0"],
      ["--framework"],
      ["--unknown"],
    ];
    for (const argv of invalidArguments) {
      expect(() => parseOptions(argv)).toThrow("invalid benchmark options");
    }
  });

  it("keeps help side-effect free and returns validated defaults", () => {
    expect(parseOptions(["--help"])).toEqual({
      help: true,
      framework: "effect-frame",
      engines: ["chrome", "webkit"],
      count: 1,
      official: false,
    });
    expect(
      parseOptions([
        "--framework",
        "octane",
        "--engine",
        "webkit",
        "--count",
        "3",
        "--only",
        "create-10k",
        "--official",
      ]),
    ).toEqual({
      help: false,
      framework: "octane",
      engines: ["webkit"],
      count: 3,
      official: true,
      only: "create-10k",
    });
  });

  it("runs every official workload unless one operation is named", () => {
    // oxlint-disable-next-line effect/noNullish -- an absent --only is the CLI boundary under test.
    expect(officialBenchmarkIds(undefined)).toEqual([
      "01_",
      "02_",
      "03_",
      "04_",
      "05_",
      "06_",
      "07_",
      "08_",
      "09_",
    ]);
    expect(officialBenchmarkIds("swap-1k")).toEqual(["05_"]);
  });
});
