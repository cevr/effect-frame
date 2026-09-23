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

The private `tooling/checks` workspace checks Effect v4 schema codecs, scope cleanup, and browser bundling. It also holds the server/client build rule. It is not a framework package.

## Commands

```sh
bun install
bun run gate
```

The gate runs strict lint, format checks, patched TypeScript checks, a browser build, and tests. Effect runtime versions are pinned in the root catalog. Type checks use the patched `tsc` binary.

No cloud deployment or npm publication is configured.

## Server and client files

A file that may run only on a server is named `*.server.ts` or `*.server.tsx`. A file with no suffix runs in both places. A browser entry may not reach a server module through any chain of imports, and it imports `effect-frame/actor/client`, not `effect-frame/actor`. `bun run boundary` checks every browser entry in `tooling/checks/src/browser-entries.ts` and fails the gate with the chain of files that reached the server module. See [the boundary rule](docs/design/boundary.md).

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

## Optimistic commands

A remote reference shows a command before the server commits it when the
client can import the actor's behavior and that behavior has `predict`.
`Behavior.value` and `Behavior.reducer` have it. `Behavior.machine` does not.

```ts
import { Effect, Option } from "effect";
import { Behavior } from "effect-frame/actor";
import { ref } from "effect-frame/actor/client";

const notes = Behavior.reducer({ initial: [], reduce: addNote });

const program = Effect.gen(function* () {
  const list = yield* ref(Notes, key, { resume: Option.none(), behavior: notes });
  const handle = yield* list.send({ _tag: "Add", text: "hello" });
  // { revision: { _tag: "Provisional", base: 0, depth: 1 }, state }
  const shown = yield* list.displayed.get;
  // The committed revision only.
  const committed = yield* list.applied.get;
  return { handle, shown, committed };
});
```

- `displayed` is what the reference shows. `state` is `displayed.state`.
- `applied` stays committed. Use it for resume data.
- Only a fresh command ID predicts. A supplied ID waits for its receipt.
- A committed state replaces the prediction. A rejected command leaves the
  pending log, and the rest replays over the same base. An `Uncertain`
  command keeps its prediction until a retry settles it.
- A query `override` shows a value as stale until any authoritative value
  replaces it: a command reply's refresh, a `refresh`, or a new declaration.

See [the optimistic send design](docs/design/optimistic.md).

## Routing

`effect-frame/router` exports one route model on the `Route` namespace. A
segment is an address. A branch is a segment with its view. A mount picks the
rendering mode for a whole tree; `Route.client` is the one mode today.

```tsx
import { Link, Route, link, mount } from "effect-frame/router";
import { Loading, View } from "effect-frame/view";
import { Effect, Schema } from "effect";

// A flat route is the one-leaf shorthand of the same model.
const Login = Route.client("login", {
  path: "/login",
  params: Schema.Struct({}),
  search: Route.search(Schema.Struct({ next: Schema.String.pipe(Route.withDefault("/")) })),
  view: (props) => Effect.succeed(<p>{View.bind(props.search, (s) => s.next)}</p>),
});

const tenant = Route.segment("tenant", {
  path: "/app/:tenant",
  params: Schema.Struct({ tenant: Schema.String }),
  data: ({ params }) => ({ info: Route.query(TenantInfo, { tenant: params.tenant }) }),
  before: ({ params, url }) =>
    Effect.gen(function* () {
      if (yield* isSignedIn(params.tenant)) {
        return Route.Continue;
      }
      return Route.redirect(Route.target(Login, {}, { next: `${url.pathname}${url.search}` }));
    }),
});

const post = Route.child(tenant, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
});

const App = Route.client(
  "app",
  Route.layout(
    tenant,
    [
      Route.leaf(
        post,
        View.lazy(() => import("./post-view.js")),
        {
          errored: (failure) => <p>{View.bind(failure, (f) => f._tag)}</p>,
          pending: { fallback: <p>opening</p>, after: "100 millis", atLeast: "300 millis" },
        },
      ),
    ],
    (props) =>
      Effect.gen(function* () {
        const first = yield* link(post, { tenant: "t1", postId: "1" }, {});
        const body = yield* Loading({ fallback: <p>loading</p>, children: props.outlet });
        return (
          <section>
            <Link link={first}>first post</Link>
            {body}
          </section>
        );
      }),
  ),
);

const program = Effect.gen(function* () {
  yield* mount({ routes: [App, Login], notFound, host, root });
});
```

- `before` runs parent first, before anything commits. It returns
  `Route.Continue` or `Route.redirect(Route.target(...))`.
- A view that can fail, and every `View.lazy` view, needs an `errored`
  handler. It receives a `Route.RouteFailure`.
- Every segment view gets `params`, `search`, `data`, `href`,
  `updateSearch`, and `replaceSearch`. A layout also gets `outlet`.
- `link` takes a flat route or a segment. `Link` draws `aria-current="page"`
  on the destination, and `aria-current="true"` on a segment the current URL
  continues below. Neither holds on not-found or on another route.
- `Route.client(name, root)` takes a branch of a root segment only.
- Leave checks and navigation receipts are not public yet (#56).

See [the public route design](docs/design/route-public.md).

## Plain-form commands

A command form works with no JavaScript. The server renders a real
`<form method="post">`; the hydrated page sends the same message over the
actor transport.

```tsx
import { HttpServer } from "effect-frame/actor";
import { Form, Generated } from "effect-frame/actor/client";
import type { RemoteActorRef } from "effect-frame/actor/client";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";

// The render mints `id` with the command id. Decoding never mints it.
const Add = Schema.TaggedStruct("Add", {
  id: Generated.fromCommandId(Schema.String),
  text: Schema.String,
  pinned: Form.Checkbox, // absent is false
});

const Compose = (props: { readonly notes: RemoteActorRef<typeof Notes> }) =>
  Effect.gen(function* () {
    const add = yield* View.form({
      ref: props.notes,
      contract: Notes,
      key: { tenant: "demo", list: "inbox" },
      message: Add,
      typed: ["text", "pinned"],
      endpoint: "/actors",
      returnTo: "/",
    });
    return (
      <form onSubmit={add.submit}>
        <input name="text" />
        <input type="checkbox" name="pinned" />
        {add.issues.map((issue) => (
          <p>{issue.message}</p>
        ))}
      </form>
    );
  });

// Server: mount beside the JSON handler, at `/actors/form`.
const forms = HttpServer.form({ contracts: [Notes], render: (path) => renderPage(path) });
```

- `effect-frame/actor/client` exports `Generated` (`fromCommandId`,
  `freshId`, `send`, `Input`) and `Form` (`codec`, `Checkbox`,
  `FormContext`, `FormIssues`, `issuesOf`, `encodeKey`, and the field-map
  helpers). `Wire.paths.form` is `/form`.
- `View.form` returns `{ submit, issues, commandId }`. The runtime draws
  `method`, `action`, and the hidden `$command`, `$contract`, `$version`,
  `$key`, `$return`, `_tag`, and generated inputs in every host.
- `HttpServer.form` answers 303 to `$return` on success, 200 with the page
  and its `FormIssues` on a validation failure, 504 with the same id on a
  lost reply, and 400 or 415 before any send.
- `Generated.send(ref, contract, input)` sends from code. The input omits
  every generated field.
- A field whose name has a segment that starts with `_` is never written
  back into a refused page. A multipart body is refused with 415.
- `HostEvent.form` carries the submitted fields on a DOM submit.
  `Prepared.post` carries a form's plain post.

See [the plain-form design](docs/design/plain-forms.md).

## Planning

Read [the GitHub tracker guide](docs/wayfinder/github.md) before changing the map. Read source findings in `docs/research/` when they are available.
