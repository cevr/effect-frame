# Effect Frame

An Effect-native full-stack framework: actors that hold state, queries that
read it, typed JSX views that draw it, and a router that owns a page's
data. It is published on npm as `effect-frame`.

The [first-release map](https://github.com/cevr/effect-frame/issues/1) is the
source of truth for scope and decisions. GitHub child issues hold the open
questions.

## Where to read

- [`packages/effect-frame/README.md`](packages/effect-frame/README.md): the
  reference for writing an app. A first app, then one section per feature,
  and every code block is a compiled, tested example.
- [`AGENTS.md`](AGENTS.md): how to work in this repository. Read it before
  a change.
- [`CONTEXT.md`](CONTEXT.md): the glossary. Each term is defined once and
  names its code.
- [`docs/toolchain.md`](docs/toolchain.md): the toolchain and its checks.
- `docs/design/`: decision records. They explain why a design is what it is,
  as of its day; the package README and the JSDoc are the reference.

## Workspace

| Path                           | What it is                                                             |
| ------------------------------ | ---------------------------------------------------------------------- |
| `packages/effect-frame`        | the framework, the one published package                               |
| `packages/inspect`             | the `effect-frame` executable: the inspection gateway and reader       |
| `packages/host-durable-object` | a host on a Cloudflare Durable Object (private)                        |
| `apps/notes`                   | the end-to-end example: every rendering mode, a browser and a terminal |
| `apps/dashboard`               | many queries, one live stream                                          |
| `apps/blog`                    | a prerendered site with one live island per post                       |
| `tooling/checks`               | the build rules the gate runs (private)                                |
| `tooling/dom-bench`            | the DOM benchmark (private)                                            |

## Commands

```sh
bun install
bun run gate
```

The gate runs strict lint, format checks, patched TypeScript checks, the doc
rules, a browser build, the boundary and declaration checks, and every
test. It needs Bun 1.4.2.

## Planning

Read [the GitHub tracker guide](docs/wayfinder/github.md) before changing the
map. Read source findings in `docs/research/` when they are available.
