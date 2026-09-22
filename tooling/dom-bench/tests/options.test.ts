import { describe, expect, it } from "bun:test";
import { parseOptions } from "../src/options.js";

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
});
