/* oxlint-disable effect/noAsyncFunction, effect/noGlobals -- this proof runs a real child process behind a real shell pipe. */
import { describe, expect, it } from "bun:test";

const flood = `${import.meta.dir}/fixture/flood.ts`;

describe("process exit", () => {
  it("delivers a large document through a slow shell pipe before it exits", async () => {
    const bytes = 1024 * 1024;
    // A shell pipe with a reader that starts late: the pipe's buffer fills
    // while the writer wants to exit. (Bun.spawn's own pipe does not show
    // the cut, so the test goes through bash.)
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        `bun "${flood}" ${bytes} | (sleep 0.3; wc -c | tr -d ' '); echo "exit=\${PIPESTATUS[0]}"`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const [received, exit] = (await new Response(child.stdout).text()).trim().split("\n");
    expect(await child.exited).toBe(0);
    expect(received).toBe(String(bytes));
    expect(exit).toBe("exit=3");
  });
});
