/* oxlint-disable effect/noNullish -- the canonical benchmark state deliberately uses null for no selected row. */

export type OperationName =
  | "create-1k"
  | "replace-1k"
  | "update-10th-10k"
  | "select-1k"
  | "swap-1k"
  | "remove-1k"
  | "create-10k"
  | "append-10k"
  | "clear-10k";

export interface Row {
  readonly id: number;
  readonly label: string;
}

export interface BenchmarkState {
  readonly rows: ReadonlyArray<Row>;
  readonly selected: number | null;
  readonly nextId: number;
}

export interface InvariantResult {
  readonly ok: boolean;
  readonly rows: number;
  readonly selected: number | null;
  readonly reason?: string;
}

export const adjectives: ReadonlyArray<string> = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
];

export const colors: ReadonlyArray<string> = [
  "red",
  "yellow",
  "blue",
  "green",
  "pink",
  "brown",
  "purple",
  "brown",
  "white",
  "black",
  "orange",
];

export const nouns: ReadonlyArray<string> = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
];

const contains = (values: ReadonlyArray<string>, value: string | undefined): boolean =>
  value !== undefined && values.includes(value);

const randomIndex = (seed: number, length: number): number => {
  const value = (Math.imul(seed ^ 0x9e3779b9, 1_664_525) + 1_013_904_223) >>> 0;
  return Math.round((value / 0xffffffff) * 1_000) % length;
};

/**
 * The official fixture chooses each word with Math.random(). A seeded source
 * keeps this harness reproducible while preserving the same three-word data
 * shape and vocabulary.
 */
export const labelFor = (index: number, firstId = 1): string => {
  const seed = Math.imul(index + 1, 2_654_435_761) ^ firstId;
  return `${adjectives[randomIndex(seed, adjectives.length)]} ${colors[randomIndex(seed + 1, colors.length)]} ${nouns[randomIndex(seed + 2, nouns.length)]}`;
};

const baseLabel = (label: string): string => {
  if (label.endsWith(" !!!")) return label.slice(0, -4);
  return label;
};

export const isCanonicalLabel = (label: string): boolean => {
  const base = baseLabel(label);
  const words = base.split(" ");
  return (
    words.length === 3 &&
    contains(adjectives, words[0]) &&
    contains(colors, words[1]) &&
    contains(nouns, words[2])
  );
};

export const makeRows = (count: number, firstId = 1): ReadonlyArray<Row> =>
  Array.from({ length: count }, (_, index) => {
    const id = firstId + index;
    return { id, label: labelFor(index, firstId) };
  });

const updateRow = (row: Row, index: number): Row => {
  if (index % 10 === 0) return { ...row, label: `${row.label} !!!` };
  return row;
};

export const updateEveryTenth = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  rows.map(updateRow);

export const swapRows = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => {
  if (rows.length < 999) {
    return rows;
  }
  const next = rows.slice();
  const first = next[1];
  const second = next[998];
  if (first === undefined || second === undefined) {
    return rows;
  }
  next[1] = second;
  next[998] = first;
  return next;
};

export const apply = (state: BenchmarkState, operation: OperationName): BenchmarkState => {
  switch (operation) {
    case "create-1k":
    case "replace-1k":
      return { rows: makeRows(1_000, state.nextId), selected: null, nextId: state.nextId + 1_000 };
    case "update-10th-10k":
      return { ...state, rows: updateEveryTenth(state.rows) };
    case "select-1k":
      return { ...state, selected: 1 };
    case "swap-1k":
      return { ...state, rows: swapRows(state.rows) };
    case "remove-1k":
      return { ...state, rows: state.rows.filter((row) => row.id !== 1), selected: null };
    case "create-10k":
      return {
        rows: makeRows(10_000, state.nextId),
        selected: null,
        nextId: state.nextId + 10_000,
      };
    case "append-10k":
      return {
        ...state,
        rows: [...state.rows, ...makeRows(1_000, state.nextId)],
        nextId: state.nextId + 1_000,
      };
    case "clear-10k":
      return { rows: [], selected: null, nextId: state.nextId };
  }
};

const mismatch = (reason: string, state: BenchmarkState): InvariantResult => ({
  ok: false,
  rows: state.rows.length,
  selected: state.selected,
  reason,
});

export const inspectDom = (root: ParentNode, state: BenchmarkState): InvariantResult => {
  const actual = Array.from(root.querySelectorAll("tbody tr")).map((row) => ({
    id: Number(row.getAttribute("data-row-id")),
    label: row.querySelector("td:nth-of-type(2)>a")?.textContent ?? "",
    selected: row.classList.contains("danger"),
  }));
  if (actual.length !== state.rows.length) {
    return mismatch(`row count ${actual.length} != ${state.rows.length}`, state);
  }
  for (const [index, expected] of state.rows.entries()) {
    const found = actual[index];
    if (found === undefined || found.id !== expected.id || found.label !== expected.label) {
      return mismatch(`row ${index} differs`, state);
    }
    if (found.selected !== (expected.id === state.selected)) {
      return mismatch(`selection for row ${expected.id} differs`, state);
    }
  }
  const selected = actual.filter((row) => row.selected).map((row) => row.id);
  if (selected.length > 1 || (selected[0] ?? null) !== state.selected) {
    return mismatch("selected row differs", state);
  }
  return { ok: true, rows: actual.length, selected: state.selected };
};

export const initialState: BenchmarkState = { rows: [], selected: null, nextId: 1 };

declare global {
  interface Window {
    __benchInvariant?: () => InvariantResult;
    __benchCommit?: () => void;
    __benchReady?: boolean;
    __benchTiming?: { start: number; end: number };
    __benchVersion?: number;
    __benchNextId?: number;
    __benchNodeId?: number;
    __benchNodeTokens?: Record<number, string>;
  }
}
