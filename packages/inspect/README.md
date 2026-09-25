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

- `gateway` listens on `127.0.0.1` only (default port 4318). Its state
  directory defaults to `$XDG_STATE_HOME/effect-frame/inspect`, else
  `$HOME/.local/state/effect-frame/inspect`; a relative `XDG_STATE_HOME` or a
  missing `HOME` exits 2. The directory must belong to you, and the gateway
  sets it to mode 0700. One gateway owns a directory at a time through
  `gateway.lock` (its PID); a lock whose PID is dead is taken over. The
  gateway writes `attach-token` and `read-token` with mode 0600 and prints the
  URLs and file paths on stderr. It removes both files and its lock when it
  stops on SIGINT, SIGTERM, or SIGHUP.
- Readers take the read capability from `--token-file` or
  `EFFECT_FRAME_INSPECT_TOKEN`. No command takes a capability as a flag, and
  no command prints one on stdout.
- Text is the default output. It escapes C0 and C1 controls, DEL, and the
  bidirectional controls in every snapshot string as `\u{..}`. `--json`
  prints exactly one versioned document on stdout for every exit code.
- Exit codes: 0 success; 1 operational failure; 2 invalid arguments, missing
  capability, or empty invocation; 130 SIGINT, 143 SIGTERM, 129 SIGHUP.
- The deadline is always finite: default 5000 ms, maximum 30000 ms. A selector
  that matches several roots fails with `AmbiguousRoot`; no root is chosen for
  you.

## Attach a development root

<!-- example: ../effect-frame/examples/features/inspection.ts#attach -->

```ts
// Development entry only: a production entry imports nothing from
// effect-frame/inspection. It needs the root's `Frame.Service`, returns at
// once, and retries in the background.
export const attach = (attachToken: string) =>
  Effect.gen(function* () {
    const attachment = yield* attachGateway({
      url: "ws://127.0.0.1:4318",
      token: attachToken,
      retry: defaultRetry,
      openTimeout: defaultOpenTimeout,
    });
    return attachment.status; // a Stream: the current status, then each change
  });
```

`attachGateway` needs the root's `Frame.Service` in context. It returns at
once and retries in the background; mount never waits for the gateway.
`attachment.status` is a `Stream` of the connection's status: the current
value, then each change.
