# The server/client boundary

Date: 2026-09-22. This document is the rule text for the file convention that
separates server code from client code, and the build rule that enforces it.
It refines the `Server/client boundary` row of `docs/design/progressive.md`
("File convention enforced by a build rule. No wrapper.") and implements
[#24](https://github.com/cevr/effect-frame/issues/24).

## The rule

1. **A server module is named `*.server.ts` or `*.server.tsx`.** The suffix
   sits on the basename, before the extension. Server views, query
   implementations, actor implementations, and hosts are server modules.

2. **There is no client suffix.** A file with no suffix runs in both places.
   That is the normal case and it carries no marker, because a view that
   draws in the DOM and a view that draws through a `RemoteHost` are the
   same file. Marking the common case would mark almost every file.

3. **A browser entry may not reach a server module.** Not directly, and not
   through any chain of imports. The browser entries are listed in
   `tooling/checks/src/browser-entries.ts`. Adding one is a boundary
   decision, so the list is written, not discovered.

4. **A browser entry may not import `effect-frame/actor`.** It imports
   `effect-frame/actor/client`. The full entry re-exports hosts, stores,
   and implementations.

5. **Imports point one way.** A server module may import anything. Nothing
   a browser entry reaches may import a server module. A server entry, such
   as `apps/notes/src/server.ts`, is not a browser entry and may import a
   server module.

6. **The rule fails the build.** `bun run boundary` runs in `bun run gate`
   after `bun run build`, and in the pre-commit hook. A violation reports
   the chain of files from the browser entry to the refused import.

## Why a suffix and not a directory

A `server/` directory states where a file lives. A suffix states what a file
is. The two differ when a feature owns both halves: `notes.server.ts` sits
beside `page.tsx`, and a move to `server/notes.ts` splits one feature across
the tree. The suffix also travels with the file, so a move cannot drop the
marker. `apps/notes/src/notes.server.ts` used this convention before the rule
existed.

Remix and SvelteKit both ship `*.server.*`. A newcomer already reads the
convention correctly.

## Why the bundler and not a lint rule

The rule must refuse a leak that is three files deep. A lint rule reads one
file at a time, so it sees only a direct import. oxlint 1.83 has no
`import/no-restricted-paths`. `no-restricted-imports` matches specifiers in
the file it reads, and no more.

`Bun.build` walks the whole graph. `tooling/checks/src/boundary.ts` bundles
each browser entry with `metafile: true` and the `source` condition, then
walks the metafile's import graph breadth first from the entry. What the rule
refuses is therefore exactly what a page would download. A server module is
found by its resolved path, so `./notes.server`, `./notes.server.js`, and a
re-export all count. The full actor entry is found by the specifier as
written.

The lint rule stays as a second, faster layer. `.oxlintrc.json` sets
`no-restricted-imports` for any `*.server` specifier, and turns it off in
server modules, server entries, tests, and scripts. It cannot carry the
`effect-frame/actor` half, because server code legitimately imports the full
entry. Only the build rule knows which graph an import sits in.

## What the report looks like

```
boundary: ./apps/notes/src/client.tsx
refused a server module (*.server.*):
  ./apps/notes/src/client.tsx
    -> ./apps/notes/src/page.tsx
      -> ./notes.server.js
```

The entry is first. The refused specifier is last, as it is written in the
importer. Each hop is one line. The rule does not enter a refused module, so
each leak reports once, with its shortest chain.

## Nesting a client view inside a server view

A server view imports its client child views by their ordinary specifiers.
Nothing marks the nesting:

```tsx
// dashboard.server.tsx: a server view
import { Counter } from "./counter.js"; // an ordinary view, runs in both places
```

The client bundle reaches `counter.tsx` from its own browser entry. It never
imports `dashboard.server.tsx`, and the build rule guarantees that. Server
files import client files. Client files never import server files.

## What tsconfig needs

Nothing. `types: ["bun"]` in the root `tsconfig.json` is global, and the Bun
types include the DOM lib. A split of `types` or `lib` per suffix would turn
one project into two and still not enforce the rule: a server module may hold
a view that touches DOM types through a `RemoteHost`. Types describe what a
value is, not where a file may run. The boundary is a graph property, and the
build rule measures it.

## Proof

`tooling/checks/tests/boundary.test.ts` runs in `bun run gate`:

- Each listed browser entry reaches no server module.
- "a server module three files deep is refused with its path chain"
- "the notes browser entry is refused when its page imports notes.server.ts"
  injects the import into the real `apps/notes/src/page.tsx` for one build,
  with no file written.
- "the full actor entry is refused from a browser entry"
- "a browser entry may reach the child view a server view nests"
