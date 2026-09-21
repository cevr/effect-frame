/**
 * The cost of Effect `Match` against a hand-written guard chain, on the
 * shape `QueryState.match` folds (#48). Run with
 * `bun run tests/perf/match.bench.ts`. Three forms: the guard chain, a
 * matcher built on every call (`Match.value`), and a matcher built once
 * (`Match.type`) and applied per call.
 */
/* oxlint-disable effect/noGlobals, typescript/no-non-null-assertion -- a script, not a module */
import { Match } from "effect";

type State =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: number; readonly stale: boolean }
  | { readonly _tag: "Failed"; readonly error: string };

const states: ReadonlyArray<State> = [
  { _tag: "Loading" },
  { _tag: "Ready", value: 1, stale: false },
  { _tag: "Failed", error: "x" },
  { _tag: "Ready", value: 2, stale: true },
];

const cases = {
  Loading: () => 0,
  Ready: (s: Extract<State, { _tag: "Ready" }>) => s.value,
  Failed: (s: Extract<State, { _tag: "Failed" }>) => s.error.length,
};

const guard = (s: State): number => {
  if (s._tag === "Loading") return cases.Loading();
  if (s._tag === "Ready") return cases.Ready(s);
  return cases.Failed(s);
};

const perCall = (s: State): number =>
  Match.value(s).pipe(Match.withReturnType<number>(), Match.tagsExhaustive(cases));

const built = Match.type<State>().pipe(Match.withReturnType<number>(), Match.tagsExhaustive(cases));

const N = 2_000_000;

const time = (name: string, f: (s: State) => number): void => {
  let acc = 0;
  // warm
  for (let i = 0; i < 100_000; i++) acc += f(states[i & 3]!);
  const heapBefore = process.memoryUsage().heapUsed;
  const start = Bun.nanoseconds();
  for (let i = 0; i < N; i++) acc += f(states[i & 3]!);
  const ns = Bun.nanoseconds() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  console.log(
    `${name.padEnd(14)} ${(ns / N).toFixed(1).padStart(6)} ns/op  heap delta ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)} MB  (${acc})`,
  );
};

for (let round = 0; round < 2; round++) {
  time("guard chain", guard);
  time("Match.value", perCall);
  time("Match.type", built);
}
