# Architecture pass 2: edges (inspection, inspect, host-durable-object, dom-bench, http + document from a consumer)

Tree: `~/Developer/personal/.worktrees/effect-frame-arch-pass2` (branch `arch-pass2`, effect-frame 0.27.0 plus the ledger). Read only. The only file written is this report.
Read first: `CONTEXT.md`, `AGENTS.md`, `packages/effect-frame/README.md` (the HTTP section, 1215-1260), `docs/design/acceptance.md`, `north-stars.md`, the ledger (the Pass 2 section and both carry-over lists), `rejected.md`, and `plans/pass1/edges.md`.
Consumer receipts: bible-tools `apps/egw-search` at `4008b04a`, which uses effect-frame 0.27.0 from npm (`node_modules/.bun/effect-frame@0.27.0+…`).

Caller-count grep, used for every count below (dist, node_modules and `*.md` excluded):
`rg -n -g '!**/dist/**' -g '!**/node_modules/**' -g '!*.md' "<pattern>" packages apps tooling | awk -F: '{print $1}' | sort | uniq -c`

Not re-proposed: E6b (routing the Durable Object by body address) is an owner decision, and this pass has no new receipt for it. E3, E7, E8, E10 and E14 are done. E11 is partial; its remainder shows up below as E2-5, with new receipts.

## Answers to the four questions

### 1. Is an `effect/unstable/http` adapter the effect-native seam?

**Yes. But the deep form is not a second adapter owned by effect-frame. The framework's handlers should speak `HttpServerRequest` → `HttpServerResponse`, and `effect` already ships both adapters.** See candidate E2-1.

Receipts for the current shape:

- **One web shape, three owners of its type.** Each is `(request: Request) => Effect<Response>`:
  - `HttpServer.WebHandler` (`packages/effect-frame/src/actor/http/server.ts:43`)
  - `Prerender.WebHandler` (`packages/effect-frame/src/router/prerender.server.ts:756`)
  - `HttpTest.Handler` (`packages/effect-frame/src/actor/testing/http.ts:6`)

  `respondDocument` returns the same `Effect<Response>` (`packages/effect-frame/src/router/document.ts:378-415`).
- **The framework's own apps mount the handler by hand in `Bun.serve`.** Each one:
  - dispatches on `url.pathname.startsWith(\`${actorPrefix}/\`)`: `apps/blog/src/server.ts:139`, `apps/notes/src/server.ts:168`, `apps/dashboard/src/server.ts:165`;
  - runs `runtime.runPromise` once per branch;
  - builds the handler first with `await runtime.runPromise(HttpServer.make(...))`: blog `:111`, notes `:148`, dashboard `:149`.

  The README's own example does the same (`packages/effect-frame/examples/counter/main.server.ts:14-26`). Blog adds a second web-handler composition for prerendered pages (`apps/blog/src/server.ts:127-143`, `Prerender.serve(loaded, router)`).
- **Nothing in the repo uses the server half of `effect/unstable/http`.** `rg "HttpRouter|HttpServerRequest|HttpServerResponse|HttpEffect" packages apps tooling` finds 0 hits outside Markdown. The client half is already adopted: `actor/http/client.ts:2` and `actor/testing/http.ts:2-3` (E9).
- **EGW converts in both directions, in two files, and in a third for tests:**
  - `bible-tools/apps/egw-search/server/main.ts:373-390`: `HttpRouter.use` → `router.add('*', \`${actorPrefix}/*\`)` → `HttpServerRequest.toWeb` → `handle(web)` → `HttpServerResponse.fromWeb`.
  - `server/document.ts:84-100`: `respondDocument(...)` piped through `Effect.map(HttpServerResponse.fromWeb)`, inside `HttpRouter.use` (`:107-126`).
  - `test/browser/server.ts:158-190`: the same actor route again.
- **The conversion is cheap. The cost is the glue at each call site, not speed.**
  - In Bun, `HttpServerRequest.toWeb` returns the source `Request` unchanged (`node_modules/effect/dist/unstable/http/HttpServerRequest.js:730-733`, `if (self.source instanceof Request) return Result.succeed(self.source)`). `@effect/platform-bun`'s request keeps `source` (`BunHttpServer.js:249-260`).
  - `HttpServerResponse.fromWeb` wraps the body as a stream (`HttpServerResponse.d.ts:859-869`).
- **`effect` ships both adapters an effect-frame handler needs:**
  - the Effect router mount: `HttpRouter.add` / `HttpRouter.use` (`HttpRouter.d.ts:197, 218`);
  - the web `fetch` for `Bun.serve` and for a Durable Object's `fetch`: `HttpEffect.toWebHandler` / `toWebHandlerWith(context)` (`HttpEffect.d.ts:84, 91`) and `HttpRouter.toWebHandler(layer)` (`HttpRouter.d.ts:693`).

  Both live in `effect` core, so `@effect/platform-bun` is not required (effect-frame has it only as a devDependency, `packages/effect-frame/package.json:111`). `HttpEffect` also drops the body of a HEAD response itself (`HttpEffect.js:198`).

**Verdict.**

- **A second adapter owned by effect-frame** (an `HttpServer.layer` that wraps today's `toWeb`/`fromWeb`) would make a real two-adapter seam: web `fetch` and Durable Object on one side, `HttpRouter` on the other. It would still be shallow, though. The deletion test moves about 8 lines back into each caller, and effect-frame would own two conversions that `effect` already owns.
- **The deeper change is to invert the handler's interface** to `Effect<HttpServerResponse, never, HttpServerRequest>` (an `HttpApp`), exported as an `HttpRouter` route layer. The web shape then comes from `HttpEffect.toWebHandler`. The seam stays, with two adapters (Bun `fetch` or Durable Object, and `HttpRouter`), and effect-frame owns neither of them.

**One trap.** A web-backed `HttpServerRequest.text` ignores `HttpIncomingMessage.MaxBodySize` (`HttpServerRequest.js:354-366` reads `this.source.text()`), so effect-frame's bounded `readText` (`actor/http/body.ts:35-65`) must stay. It would read `request.stream`.

### 2. The live check the orchestrator can run

What pass 2 is likely to touch, and the inspection record each part writes:

| Area | Code | Record it writes |
| ---- | ---- | ---------------- |
| view runtime | `packages/effect-frame/src/view/runtime.ts:1745` | `Mount` |
| local actors | `actor/local-engine.ts:133` | `Actor` with `kind: "local"` |
| router | `router/router.ts:622` | `Route` |
| router URL state | `router/url-state-runtime.ts:160` | `UrlState` |
| query cache | `actor/query-client.ts:652` | `Query` |
| commands | `actor/command-owner.ts:575` | `Command` |

`effect-frame inspect` shows all of these (`src/frame.ts:428-480`), so one `inspect --root` read covers the runtime, local actors, and the router's side-channel maps.

**No framework app attaches the gateway.** `rg "attachGateway"` finds only:

- `packages/effect-frame/examples/features/inspection.ts` (2)
- `src/inspection/attach.ts` (4) and `src/inspection/index.ts` (2)
- `tests/inspection/attach.test.ts` (7)
- `packages/inspect/tests/fixture/main.dev.tsx` (2)

So a live check through the CLI needs EGW (A below), and the in-repo proof is the inspect package's real-browser suite (B below).

**This host skips every browser proof without saying so.** No `google-chrome` or `chromium` is on `PATH` (checked with `which`), and the harnesses pick the browser with `Bun.which("google-chrome") ?? Bun.which("chromium")`: `packages/inspect/tests/harness.ts:99-109` and `apps/notes/tests/browser.ts:16-31`. A Playwright Chromium exists at `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`. Put it on `PATH` as `chromium` first (a scratch symlink; it edits nothing in the repo):

```sh
S=<scratchpad>; mkdir -p $S/bin && ln -sf ~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome $S/bin/chromium
export PATH=$S/bin:$HOME/.cache/bun142:$PATH
```

Ports in use on this host at the time of the sweep (`ss -ltn`): 22, 53, 80, 2222, 6300, 6379, 6380, 8228, 8384, 9999, and several high ports. 3101, 3141-3143 and 4318-4319 were free. The commands below use 3141-3143 and 4319, never 3102 or 3187.

**A. EGW Search.** It exercises `Route.streamed` plus `hydrate`, three `Actor.local`, the query cache, and URL search state: `src/routes.tsx:41`, `src/boot.tsx:46`, `src/app.tsx:270,467,722`. Its root is named `egw-search` (`src/boot.tsx:69`), and its corpus is at `~/.bible` (`bible.db`, `egw-paragraphs.db`, `models`: present).

As installed, EGW runs the published 0.27.0, which is exactly the pass 1 check still marked `<pending>`. For pass 2, run it again after EGW adopts the pass 2 release (the loop's EGW step). Linking the worktree into bible-tools edits bible-tools, which is the orchestrator's call.

```sh
# terminal 1: the gateway, from the effect-frame worktree, on the worktree's source
cd ~/Developer/personal/.worktrees/effect-frame-arch-pass2
bun --conditions=source packages/inspect/src/bin.ts gateway \
  --origin http://127.0.0.1:3141 --port 4319 --state-dir $S/inspect
# terminal 2: EGW, with its dev bundle (index.dev.tsx asks /__inspect for the gateway)
cd ~/Developer/personal/bible-tools/apps/egw-search
bun build src/index.dev.tsx --target browser --format esm --outfile dist/index.js && cp src/styles.css dist/
PORT=3141 EGW_INSPECT=1 EGW_INSPECT_GATEWAY=ws://127.0.0.1:4319 EGW_INSPECT_STATE_DIR=$S/inspect bun server/main.ts
# terminal 3: open the page at the exact origin the gateway allows, then read it
agent-browser open 'http://127.0.0.1:3141/?q=sanctuary'
cd ~/Developer/personal/.worktrees/effect-frame-arch-pass2
bun --conditions=source packages/inspect/src/bin.ts roots   --url http://127.0.0.1:4319 --token-file $S/inspect/read-token --json
bun --conditions=source packages/inspect/src/bin.ts inspect --url http://127.0.0.1:4319 --root egw-search --token-file $S/inspect/read-token --json
```

Notes on these commands:

- `NODE_ENV` must not be `production` (`server/inspect.ts:49`).
- The gateway compares `Origin` exactly (`packages/inspect/src/gateway.ts:454-456`), so open `127.0.0.1`, not `localhost`.
- What to check in the `inspect` output:
  - `actors[].kind` includes `"local"`;
  - `routes[].routeName` is the search route, and it changes after an in-app navigation;
  - `urlState` follows `?q=`;
  - after a navigation, no records remain from a segment that has left. This is the leak check for the router's side-channel maps.
- The query string is a guess at the search parameter; use any in-app search.
- The EGW defaults are port 3101 (`server/main.ts:69`) and gateway 4318 (`server/inspect.ts:56`); the commands above override both.

**B. The in-repo proof on the worktree's code.** It runs a real browser page with `Route.client`, `Actor.local`, `View.loading`, the `QueryCache`, and `mount`, against a real gateway and the reader (`packages/inspect/tests/fixture/app.tsx:118-190`). It asserts `routes → ["book"]` and `actors.kind → ["local"]` (`packages/inspect/tests/transport.test.ts:142-143`).

```sh
cd ~/Developer/personal/.worktrees/effect-frame-arch-pass2
bun test --conditions=source packages/inspect/tests/transport.test.ts packages/inspect/tests/protocol.test.ts
```

It passes vacuously when no `chromium` is on `PATH`: `describe.skipIf(!H.hasBrowser)` (`transport.test.ts:120`, `protocol.test.ts:299,358`). Confirm the count of tests that ran, not only a zero exit code.

**C. The framework apps in a browser, with no inspection.** These check the view runtime, local actors, and router maps visually:

- `PORT=3142 bun run --conditions=source apps/notes/src/server.ts`: `Actor.local` at `apps/notes/src/page.tsx:52,55` and `views.tsx:135`.
- `PORT=3143 bun run --conditions=source apps/dashboard/src/server.ts`: `apps/dashboard/src/views.tsx:48` and `overview.tsx:165`.

Drive both with `agent-browser`. The apps' own browser suites (`apps/notes/tests/navigation.test.ts`, `apps/blog/tests/browser.test.ts`) need the same `chromium` on `PATH`.

### 3. Module-level maps and globals

**No findings.** A re-grep of `new (Weak)?(Map|Set)` and top-level `let` over `packages/effect-frame/src/inspection`, `packages/inspect/src`, `packages/host-durable-object/src`, `packages/effect-frame/src/actor/http`, `router/document.ts`, `src/frame.ts` and `tooling/dom-bench/src` found no side-channel map.

- **Module level, and immutable constants only:**
  - `packages/inspect/src/gateway.ts:189` (`SERVER_TAGS`)
  - `packages/host-durable-object/src/route.ts:31` (`verbs`)
  - `packages/inspect/src/reader.ts:117-118` and `cli.ts:88-89` (flag specs)
  - `tooling/dom-bench/src/trace.ts:53` (`timingTypes`)
  - `packages/effect-frame/src/inspection/attach.ts:161` (a stateless `TextEncoder`)
  - `packages/inspect/src/bin.ts:13`: the process's one `AbortController`, at the process boundary, with a file-level disable and a reason.
- **Per instance, inside a function or scope:**
  - `inspection/registry.ts:151-153`: a per-root `Map` and counters inside `makeRegistry`, cleared by a finalizer at `:166-170`.
  - `gateway.ts:106, 337`: per socket, and per gateway inside the scoped `make`.
  - `flags.ts:47-48` and `dom-bench/src/process.ts:112`: per call.
  - `form-post.ts:400`: per route.

### 4. Other candidates in scope

E2-2 to E2-6 below.

## Candidates

### E2-1: The handlers speak `HttpServerRequest` → `HttpServerResponse`; `effect` supplies both adapters

- **Files:**
  - `actor/http/server.ts:43, 139-140, 271, 283, 309-316, 321, 396-412`
  - `actor/http/form-post.ts:381, 391-429`
  - `router/document.ts:354-415`
  - `router/prerender.server.ts:756-827`
  - `actor/testing/http.ts:5-46`
  - `host-durable-object/src/frame-host.ts:187, 204-222, 239-268`
  - the apps: `apps/{blog,notes,dashboard}/src/server.ts`, and `examples/counter/main.server.ts` (a README region)
- **Problem:**
  - **One concept with three owners:** the three `WebHandler` types.
  - **A pass-through at every mount:** 4 hand dispatchers in the framework (3 apps and the example), and 3 conversion sites in EGW.
  - **Hand-written Web glue where Effect has the tool:**
    - `Stream.toReadableStreamWith(body, context)` after a captured `Effect.context` (`server.ts:271, 309`; `document.ts:385, 395`), where `HttpServerResponse.stream` carries a `Stream` natively (`HttpServerResponse.js:279`);
    - the HEAD special case (`prerender.server.ts:776-783`), where `HttpEffect.js:198` does it;
    - the `new Request` building in `HttpTest.client` (`testing/http.ts:9-21, 36-46`), where `HttpServerRequest.fromClientRequest` and `HttpServerResponse.toClientResponse` exist (`HttpServerRequest.d.ts:225`, `HttpServerResponse.d.ts:~843`).

  This is P3's recorded remainder ("apps not moved to HttpRouter/BunHttpServer"). The new receipt is EGW, which writes the conversion in two production files and one test file.
- **Callers:**
  - `rg "HttpServer\.make\("`: 3 apps, 2 examples, `testing/http.ts`, `frame-host.ts`, and 14 test files. `rg "respondDocument\("`: 3 apps, 1 example, and 4 tests.
  - `rg "WebHandler"` outside tests: `frame-host.ts:187, 205`, `apps/blog/src/server.ts:127, 136`, and `examples/features/prerender.server.tsx:59`.
- **North star:** effect-native (the request and response are Effect values, and a body is a `Stream`). Declarative (an app declares routes in `HttpRouter` layers and stops sequencing `runPromise` per branch). The deletion test: effect-frame deletes its adapters and its three handler types.
- **Change:**
  - `HttpServer.make(options)` returns `Effect<HttpApp>`, where `HttpApp = Effect<HttpServerResponse, never, HttpServerRequest>`. `HttpServer.layer(options)` is `HttpRouter.use((r) => r.add("*", \`${prefix}/*\`, app))`.
  - `respondDocument` returns `Effect<HttpServerResponse>` through `HttpServerResponse.stream`, and `onTimeout` answers an `HttpServerResponse`.
  - `Prerender.serve` takes and returns an `HttpApp`.
  - `HttpTest.client(app)` goes through `fromClientRequest`/`toClientResponse`.
  - `DerivePrincipal` takes `HttpServerRequest`; cookies come parsed as `request.cookies`.
  - `frame-host` serves through `HttpEffect.toWebHandlerWith(runtimeContext)`.
  - The apps use `HttpRouter.toWebHandler(layer)` inside `Bun.serve`. No `@effect/platform-bun` is needed; blog has it already.
  - Keep `readText` over `request.stream`, because web-backed `.text` ignores `MaxBodySize` (see Q1).
- **Lines removed:** about 90 net: about 15 in `server.ts`, 10 in `document.ts`, 12 in `prerender.server.ts`, 15 in `testing/http.ts`, 10 in `frame-host.ts`, and about 30 of dispatch across the 3 apps and the example. EGW loses about 20 more.
- **Risk:** medium to high. These rows must stay green:
  - SSE `changes` streaming and principal revocation (acceptance rows at 26, 143-144, and 167-178);
  - the streamed document's Scope closing when its body ends (`tests/router/respond-document.test.ts`);
  - the Durable Object's 409 and 413 guard (`host-durable-object/tests/frame-host.test.ts:234, 247, 266`).
- **Public API change:** yes (`HttpServer`, `respondDocument`, `Prerender.serve`, `HttpTest`). It needs a changeset and a breaking `!`.
- **Wire/stored format change:** no. The paths, statuses and bodies stay the same.
- **Owner question:** none between north stars. The only thing to confirm is the appetite to build the server edge on `effect/unstable/http`, which is marked unstable. The client edge already depends on it.

### E2-2: One page-redraw for a refused plain post, not three copies

- **Files:**
  - `apps/blog/src/server.ts:62-78`
  - `apps/notes/src/server.ts:100-116`
  - `packages/effect-frame/examples/counter/page.server.ts:55-70` (a README region)
  - `actor/http/form-post.ts:52-56` (`render: (path: string) => Effect<string>`)
- **Problem:** A pass-through, written three times. Each app:
  - invents a `PageRedirected` error class;
  - invents a base origin (`"http://blog.invalid"`, `"http://notes.invalid"`, `"http://counter.invalid"`) to turn `path` back into a URL;
  - reads `CurrentPrincipal`;
  - calls `Stream.runCollect(outcome.body)` and joins the chunks.

  The magic `.invalid` base exists only because the form route hands over a path string. `rg "PageRedirected|runCollect\(outcome\.body\)"` finds 3 apps/examples in `src`, plus 3 tests.
- **North star:** declarative (the framework collects a document; the app states which page it is) and explicit (no invented origin).
- **Change:** `FormRoute.render` receives a `URL`, resolved against the posting request's own origin. The router exports one adapter from a document render to that `render`, for example `redraw((url, principal) => renderDocument({...}))`. It collects the body and fails with a tagged `DocumentRedirected`. It lives in `router` so that `actor/http` does not import `router`. `document.ts:3-4` already imports `actor/client`, so the dependency points one way only.
- **Lines removed:** about 35 across the 3 copies; about 15 added in `router/document.ts`.
- **Risk:** low.
- **Public API change:** yes (the `FormRoute.render` argument type, and one new export). **Wire/stored format change:** no.

### E2-3: The Durable Object reads each body twice, and answers 413 in a second format

- **Files:** `host-durable-object/src/frame-host.ts:239-268`. The handler's own read is at `actor/http/server.ts:106-121, 146-148`.
- **Problem:**
  - `fetch` runs `HttpServer.readText(request.clone(), maxBodyBytes)` to find the address, then passes the original `request` to the handler, which reads and bounds the same body again. A body up to 1 MiB is teed and buffered twice, and decoded twice: `Envelope` at `:77-88`, then `SendBody`/`CallBody`.
  - Its refusals are plain text (`new Response(error.message, { status: 413 })`, `:246-247`). The handler answers the same condition with a JSON `BadRequest` (`server.ts:147-148`). One concept, the refused body, has two owners.
- **North star:** explicit (one refusal shape per status) and locality.
- **Change:**
  - With no format change: read once, then pass `new Request(request, { body: text })` to the handler. With E2-1 this becomes `HttpServerRequest.modify`.
  - Making the Durable Object's 413 and 400 bodies the JSON `BadRequest` changes a response body, which is a wire change. That part is an **owner question**, rejected by default. The 409 stays as it is (tested at `tests/frame-host.test.ts:234, 247`).
- **Lines removed:** about 3.
- **Risk:** low.
- **Public API change:** no (the package is private). **Wire/stored format change:** no for the single read; yes for aligning the body format (owner).

### E2-4: The browser proofs skip silently when no browser is found

- **Files:**
  - `packages/inspect/tests/harness.ts:94-109` (`hasBrowser`), `transport.test.ts:120`, `protocol.test.ts:299, 358`
  - `apps/blog/tests/browser.test.ts:53`
  - `packages/effect-frame/tests/view/streaming-browser.test.ts:411-412`
  - Compare `apps/notes/tests/browser.ts:49-53`, which throws under `CI` when Chrome is missing.
- **Problem:** A guard gap, and one rule with several owners.
  - The live inspection proofs, which are the only automated end-to-end read of `Mount`, `Route`, `UrlState` and local `Actor` records, pass as skipped on any host without `google-chrome` or `chromium` on `PATH`. That includes this devbox (checked with `which`).
  - Only the notes harness turns "no browser" into a failure under `CI`. If CI's image ever loses Chrome, the inspection and streaming rows go green with no browser behind them.
- **North star:** explicit (a proof that did not run says so).
- **Change:** Add one shared `requireBrowser(engine)` in `tooling/checks`, or in a test helper that the packages share. Under `CI` a missing browser throws; locally it logs one line naming the skipped suites. Every harness calls it.
- **Lines removed:** about 5 (the notes copy); about 12 added.
- **Risk:** low.
- **Public API change:** no. **Wire/stored format change:** no.

### E2-5: `inspect`'s process port: one shape, Effects instead of a Promise and an AbortSignal

- **Files:**
  - `packages/inspect/src/reader.ts:26-33` (`CliEnvironment`: `token?`, `readFile?: (path) => Promise<string>`, `interrupt?: AbortSignal`)
  - `reader.ts:367-377` (`readFile ?? Bun.file(...).text()` under `Effect.tryPromise`)
  - `reader.ts:379-380` and `signals.ts:23-37` (`signalOf`, and `untilInterrupted`, an `Effect.callback` over the abort event)
  - `cli.ts:22-37, 253-257` (`Io`, with `Option` fields, is spread back into optional fields)
  - `bin.ts:13-17`
- **Problem:**
  - **A one-adapter seam with no caller.** `rg "readFile:" packages apps tooling` finds 0 hits, so the `readFile?` injection point exists only to hide a `Bun.file` default behind a Promise.
  - **One concept with two shapes.** The process environment is `Io` (`Option` fields) in `cli.ts` and `CliEnvironment` (optional fields) in `reader.ts`, converted at `cli.ts:255`.
  - **A callback where an Effect belongs.** The interrupt travels as an `AbortSignal` that is turned back into an Effect. This is the remainder of E11 that pass 1 named ("pass the interrupt as `Effect<InterruptSignal>` built in `bin.ts`"), now with the `readFile` receipt.
- **Callers:** `rg "Reader\.run\(|Client\.run\("` gives `cli.ts:254`, `tests/harness.ts:192` and `tests/reader.test.ts:83`.
- **North star:** effect-native (no Promise port, no AbortSignal round trip) and explicit (no hidden `Bun.file` default).
- **Change:** `Reader.run(argv, { token: Option<string>, interrupt: Effect<InterruptSignal> })`. `bin.ts` builds `interrupt` once, as an `Effect.callback` over `process.on`. The token file is read with `FileSystem.FileSystem`, or directly with `Bun.file` at this one boundary. Then delete `readFile`, `signalOf`, `untilInterrupted`, and the Option-to-optional spread.
- **Lines removed:** about 20.
- **Risk:** low. It is a private bin, and the exit codes and `--json` document are unchanged.
- **Public API change:** no. **Wire/stored format change:** no.

### E2-6: The three `WebHandler` types, if E2-1 is declined

- **Files:** `actor/http/server.ts:43`, `router/prerender.server.ts:756`, `actor/testing/http.ts:6`.
- **Problem:** One concept with three owners.
- **Change:** One type, `HttpServer.WebHandler`. `Prerender` and `HttpTest` import it.
- **Lines removed:** 2.
- **Risk:** none.
- **Public API change:** yes (the type name `Prerender.WebHandler` and `HttpTest.Handler`). **Wire/stored format change:** no.
- **Scope:** Only worth doing if E2-1 is declined; E2-1 deletes all three types.

## Owner questions

- **E2-1:** Build the server edge on `effect/unstable/http` (`HttpApp` with the `HttpRouter` and `toWebHandler` adapters), with public API breaks in `HttpServer`, `respondDocument`, `Prerender.serve` and `HttpTest`? No north star is traded; the question is the unstable module and the size of the break.
- **E2-3:** Should a Durable Object's 413 and 400 bodies become the JSON `BadRequest` the Bun handler sends? That is a wire change, so it is rejected by default.

## Not worth a pass (under about 5 lines, or no new receipt)

- `host-durable-object/src/route.ts:31`: the `verbs` literals repeat four values of `Wire.paths` (`actor/http/wire.ts:219-227`). Two lines. The router's URL layout is E6b's owner decision.
- `inspection/registry.ts:151-153`: a closure `Map` and `let` counters. They are per root, synchronous, and cleared by a finalizer. A `Ref` adds nothing.
- Exports in private or internal modules that only their own file uses: `inspect/src/capabilities.ts` (`FILE_MODE`, `DIRECTORY_MODE`), `cli.ts` (`Io`, `DEFAULT_PORT`, `GATEWAY_HELP`), `gateway.ts` (`GatewayStats`), `reader.ts` (`CliEnvironment`, `ClientError`, `printDocument`), `signals.ts` (`signalOf`), `host-durable-object/src/interop.ts` (`Armed`), and `inspection/registry.ts` (`ActorRecord`, `QueryStateTag`, `MountRecord`, `RouteRecord`, `UrlStateRecord`). Removing `export` is pure style.
- `frame-host.ts:298`: `holdOf` is exported for `tests/frame-host.test.ts` only (6 test hits). Carried from pass 1.
- `frame-host.ts:187, 205-222`: a `Promise` memo of the handler inside the Durable Object class. It is at the platform boundary, and it goes away with E2-1.
- `tooling/dom-bench/src` (light): every export has a caller outside its file (checked per export with the grep), and it has no module state beyond the constant `timingTypes`. No findings.
