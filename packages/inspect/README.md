# @effect-frame/inspect

The `effect-frame` executable: a loopback inspection gateway and a reader for
live Frame roots. It runs on Bun. The browser half is the public
`effect-frame/inspection` subpath; this package holds the only Bun code.

This package is private for now. The release workflow publishes only through
npm OIDC, so the first npm publish needs the owner to create
`@effect-frame/inspect` on npm and add a Trusted Publisher for this repository.

## Commands

```
effect-frame gateway --origin <app origin> [--port <n>] [--state-dir <dir>]
effect-frame roots   --url <gateway> [--json] [--deadline <ms>] [--token-file <path>]
effect-frame inspect --url <gateway> --root <id|prefix|name> [--json]
                     [--deadline <ms>] [--token-file <path>] [--max-text <n>]
```

- `gateway` listens on `127.0.0.1` (default port 4318). It writes
  `attach-token` and `read-token` with mode 0600 into the state directory
  (default `$XDG_STATE_HOME/effect-frame/inspect`, else
  `~/.local/state/effect-frame/inspect`) and prints the URLs and file paths on
  stderr. It removes both files when it stops.
- Readers take the read capability from `--token-file` or
  `EFFECT_FRAME_INSPECT_TOKEN`. No command takes a capability as a flag, and
  no command prints one on stdout.
- Text is the default output. `--json` prints exactly one versioned document
  on stdout for every exit code.
- Exit codes: 0 success; 1 operational failure; 2 invalid arguments, missing
  capability, or empty invocation; 130 SIGINT.
- The deadline is always finite: default 5000 ms, maximum 30000 ms. A selector
  that matches several roots fails with `AmbiguousRoot`; no root is chosen for
  you.

## Attach a development root

```ts
import { attach } from "effect-frame/inspection";

// Development entry only. The production entry imports nothing from
// effect-frame/inspection.
yield * attach({ url: "ws://127.0.0.1:4318", token: attachTokenFromDevServer });
```

`attach` needs the root's `Frame.Service` in context. It returns at once and
retries in the background; mount never waits for the gateway.
