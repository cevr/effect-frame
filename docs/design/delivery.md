# Delivery: packages, loops, and migration

Date: 2026-09-18. This document closes the four "Not yet specified" items of the
[map](https://github.com/cevr/effect-frame/issues/1) that are not the end-to-end
example: the build and development loop, the state and protocol migration
strategy, the mailbox storage schema and its conformance suite, and the delivery
sequence with the package split. The acceptance matrix lives in
[acceptance.md](./acceptance.md).

All commits referenced in this repository's design notes live on the local
`main` branch. Nothing is pushed. A push happens only when the owner asks.

## Package split

| Package                             | Entry           | Ships to       | Holds                                                                                                                                      |
| ----------------------------------- | --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `effect-frame/actor`                | `.`             | server         | everything below plus `durable`, `MailboxStore`, `implement`, `ActorHost`, `HttpServer`                                                    |
| `effect-frame/actor`                | `./client`      | browser        | vocabulary, `contract`, `resumeCodec`, local `spawn` and `Behavior`, remote `ref`, `ActorTransport`, `HttpTransport`                       |
| `effect-frame/actor`                | `./testing`     | tests          | the `MailboxStore` conformance suite as one Effect                                                                                         |
| `effect-frame/view`                 | `.`             | both           | `View` (a function), `View.bind`, `View.event`, `mount`, `render`, `For`, `Show`, `Dom` (incl. `hydrate`), `Html` (incl. `renderToString`) |
| `effect-frame/view`                 | `./jsx-runtime` | both           | the JSX factory the compiler targets                                                                                                       |
| `effect-frame/view`                 | `./opentui`     | terminal       | the OpenTUI host                                                                                                                           |
| `@effect-frame/host-durable-object` | `.`             | celld, workerd | `StorageStore` over Durable Object SQL, the Durable Object classes, the interop seam                                                       |
| `apps/notes`                        | app             | example        | one contract, a Bun server with server render and the HTTP transport, a hydrated browser client, a terminal client                         |

The rule behind the split: a module a browser may load never imports a store, a
host, or an implementation. `packages/actor/tests/boundary.test.ts` bundles the
`./client` entry and fails when a server marker reaches it. New server code goes
behind the `.` entry; new client code must keep that test green.

Alchemy stacks, Cloudflare and Rivet stores, and a `Route.page` helper are not
packages yet. Each is a later package that must pass the conformance suite (for a
store) or fold two existing call sites (for a helper) before it exists.

## Build and development loop

One toolchain: Bun 1.4, TypeScript 7 with the Effect language service patch,
oxlint with `oxlint-plugin-effect`, oxfmt, turbo, lefthook.

| Loop             | Command                                                                          | What runs                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gate             | `bun run gate`                                                                   | typecheck, lint, format check, and build in parallel; then every package's tests. Pre-commit runs it.                                                           |
| one package      | `bun test tests/` in the package                                                 | that package's tests; browser tests use happy-dom, terminal tests use `@opentui/core/testing`                                                                   |
| server + browser | `bun run dev` in `apps/notes`                                                    | `Bun.serve` renders the page, serves the HTTP transport, and bundles the client with `Bun.build` at start                                                       |
| terminal         | `bun run terminal` in `apps/notes`                                               | the OpenTUI client against a running server URL                                                                                                                 |
| celld            | `bun run fixture` then `bun run proof:celld` in `packages/host-durable-object`   | `bun build --target browser --format esm` produces the worker; `celld dev --no-watch` serves it with `no_bundle: true`; the harness kills and restarts the node |
| workerd          | `bun run fixture` then `bun run proof:workerd` in `packages/host-durable-object` | the same worker; `workerd serve` runs it with a config derived from the fixture's `wrangler.jsonc`; the harness kills and restarts the one process              |

Browser bundles come from `bun build --target browser` with `effect` and
`effect-machine` external for library packages and inlined for apps. celld
accepts the same output, so one bundler serves the browser and the worker. No
Vite, no esbuild, no Node-only build step.

Proof scripts (`proof:celld`, `proof:contract`) stay outside the default gate:
they need the celld binary and take seconds per restart. They run by hand before
a release and in a scheduled job later.

## State and protocol migration

Three things carry a version: the contract, the stored state, and the mailbox
schema.

**Contract.** `Actor.contract(name, { version, ... })` puts `version` on every
wire address. A host that serves another version fails the request with
`ContractMismatch { expected, actual }`, typed on the `remote` kind only. Bump
the version when `key`, `snapshot`, or `message` changes so that an old client
cannot decode a new payload. Add new message members without a bump; a host that
receives an unknown member fails to decode it and the client sees a defect, so
ship the server first.

**Stored state.** A durable actor persists the encoded state string the
implementation's `state` codec produced. On restore, `durable` decodes the
latest committed string with the same codec. A state shape change is a codec
change: the new codec must decode the old encoded form. Effect Schema does that
with a union of the old and new shapes and a transformation to the new one; the
old form is decoded once, and the next commit writes the new form. Receipts keep
the encoded state as committed at that time; they are history and are not
rewritten. A change the codec cannot express is a new contract name with a new
store.

**Mailbox schema.** The storage store owns two tables:

```sql
CREATE TABLE IF NOT EXISTS commands (
  admitted     INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id   TEXT UNIQUE,
  payload      TEXT,
  payload_hash INTEGER,
  revision     INTEGER NULL,
  state        TEXT NULL
);
CREATE TABLE IF NOT EXISTS committed (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER,
  state    TEXT,
  wake_at  INTEGER NULL
);
```

**Wakes (#101 §5).** A behavior may name `wakeAt(state)`: the epoch
milliseconds at which that state next needs the actor running with no
request. `Running` work in flight names a time at or before now; a deadline
names the time the state holds. The engine passes the wake to `commit` and
`advance`, and the store keeps it in `committed.wake_at` in the same step as
the state. The storage store arms the alarm in that transaction: now while a
command is pending, otherwise the wake, never earlier than now (workerd
refuses a past alarm, and the commit with it). The alarm opens the actor and
holds until no command is pending and the wake is absent or later than now;
work still in flight at the hold's bound arms the next alarm at once. A
waiting machine sleeps until the time its state carries, not for a duration,
because a reopened machine re-enters its task from the start.

`admitted` and `revision` are two counters: admission order and commit order.
`revision` is shared by command commits and autonomous `advance` commits, so one
clock orders every observable state. The DDL runs on every open and is
idempotent. Schema changes are additive statements appended to that list; a
change that cannot be additive introduces a `schema_version` row and a migration
step that runs inside one storage transaction before the actor opens. Receipts
are retained without bound in the first release; `compact` is a later store
operation.

**Conformance.** `effect-frame/actor/testing` holds the cases every
`MailboxStore` must pass: starts empty; append admits in order and `next` walks
admission order; a duplicate append carries the receipt; a conflicting payload
fails with `CommandConflict`; `commit` advances one revision and updates
`latest`; `advance` shares the revision clock; a receipt is absent until commit
and stable after it; `next` never skips a pending command; a seen command ID
is never admitted again; a receipt outlives the retry bound; the wake is
stored with the latest commit. The in-memory store
and the celld storage store pass it. A Cloudflare or Rivet store is accepted when
it passes the same suite and the recovery harness rows.

## Delivery sequence

| Step | Content                                                                                     | State                                                                         |
| ---- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1    | actor core: behaviors, local and durable references, in-memory store, conformance suite     | done (`536304f`, `11487f3`, `dd2a269`)                                        |
| 2    | client and server boundary: contract, implement, in-process host, remote reference          | done (`4bc7973`)                                                              |
| 3    | HTTP transport with revision stream and reconnect                                           | done (`1227f3a`)                                                              |
| 4    | view runtime with DOM and OpenTUI hosts                                                     | done (`eafdef5`)                                                              |
| 5    | server render, snapshot transfer, hydration                                                 | done (`5942fdb`)                                                              |
| 6    | celld host: storage store, Durable Object, crash harness                                    | done (`83fc70d`); generic host in progress                                    |
| 7    | end-to-end example and acceptance matrix                                                    | in progress                                                                   |
| 7a   | query primitive and cache (#17, #28), readiness through context (#16), Show ownership (#26) | done on `build/egw-search` (`638104c`, `5914524`, `12636d2`)                  |
| 7b   | leaf router: route codec, navigation, browser location (#18, SPA mode only)                 | done on `build/egw-search` (`6259e4a`); layouts, SSR and streaming modes open |
| 8    | Cloudflare and Rivet stores against the conformance suite; Alchemy stack example            | not started; needs accounts, so out of this effort                            |
| 9    | npm release                                                                                 | not approved                                                                  |

Each step landed on `main` with the gate green and a linked decision on its
ticket. Steps 8 and 9 stay open on the map as out of scope for this effort.
