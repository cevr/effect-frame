# Effect Frame

An Effect-native full-stack framework in design and implementation.

The [first-release map](https://github.com/cevr/effect-frame/issues/1) is the source of truth for scope and decisions. GitHub child issues hold the open questions.

## First release

- One explicit actor interface for simple state and state machines.
- Local and remote actor hosts.
- Declarative JSX for browser and OpenTUI clients.
- Server rendering and hydration.
- Real celld persistence for state, accepted commands, command results, and resumable machine work.
- Alchemy as the infrastructure interface.

These are release requirements. They are not implemented features.

## Current state

The workspace contains the project tools and their compatibility probes. It does not yet contain a framework runtime. The actor API, renderer adapter, and recovery model remain open decisions on the map.

The private `tooling/checks` workspace checks Effect v4 schema codecs, scope cleanup, and browser bundling. It is not a framework package.

## Commands

```sh
bun install
bun run gate
```

The gate runs strict lint, format checks, patched TypeScript checks, a browser build, and tests. Effect runtime versions are pinned in the root catalog. Type checks use the patched `tsc` binary.

No cloud deployment or npm publication is configured.

## Browser inspection

The browser-safe `effect-frame/frame` entry exposes `Frame.layer` and
`Frame.inspect`. Build one Frame layer for each application root. Keep it in
the same layer graph as the query cache so the cache registers its entries in
that root.

```ts
import * as Frame from "effect-frame/frame";
import { Layer } from "effect";
import { queryCacheLayer } from "effect-frame/actor/client";

const frameLayer = Frame.layer({ name: "notes" });
const appLayer = Layer.merge(queryCacheLayer.pipe(Layer.provideMerge(frameLayer)), transportLayer);
```

`Layer.provideMerge` gives the cache the Frame registry and keeps the Frame
service available to the mounted application. A test host uses the same
composition with `QueryTest.layer`:

```ts
const testLayer = QueryTest.layer({ queries: [NotesQueryLive] }).pipe(
  Layer.provideMerge(Frame.layer({ name: "notes-test" })),
);
```

Keep the cache layer alive for the full mounted application scope. Providing a
cache only around a short setup effect closes its `RcMap` when that effect
returns, even if an outer view scope still holds a query consumer.

### Live inspection

The browser-safe `effect-frame/inspection` subpath exports `Protocol` (the
versioned wire contract) and `attachGateway`. A development entry calls
`attachGateway` to connect its root to a loopback gateway. A production entry imports nothing
from this subpath and carries none of it. The gateway and the reader are the
`effect-frame` executable in `packages/inspect` (`effect-frame gateway`,
`effect-frame roots`, `effect-frame inspect`), the only Bun piece. See
[the inspection gateway design](docs/design/inspection-gateway.md).

Public subpaths of `effect-frame`: `actor`, `actor/client`, `actor/testing`,
`frame`, `inspection`, `view`, `view/testing`, `view/jsx-runtime`,
`view/jsx-dev-runtime`, `view/opentui`, and `router`.

## Planning

Read [the GitHub tracker guide](docs/wayfinder/github.md) before changing the map. Read source findings in `docs/research/` when they are available.
