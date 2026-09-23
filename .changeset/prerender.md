---
"effect-frame": minor
---

Prerender route trees at build time, serve what the build wrote before the router, and resume a loaded page (#23, #86).

New exports on `effect-frame/router`:

- `Route.prerender(name, branch, { inputs })` and `Route.prerender(name, { ...definition, inputs })`: the fifth mode constructor. A call without `inputs` does not compile. The tree registers `AwaitAll`, so `renderDocument` renders a prerender URL with no built file through the same pipeline.
- `Route.inputs(segment, enumerate)`: how one segment enumerates the params it adds. A root segment's `enumerate` is an Effect of its params records; a child's is a function of its ancestors' params that returns only its own. A child's inputs run once for each parent.
- `Route.PrerenderAncestorNotEnumerable { route, leaf, ancestor, param }`: `Route.prerender` throws it when a segment adds a path param and names no inputs. `Route.PrerenderInputsRejected { route, segment, reason }`: inputs for a segment outside the tree, or twice for one segment.
- The types `Route.Inputs`, `Route.AnyInputs`, `Route.Enumerate`, `Route.OwnParams`, `Route.Prerendered`, `Route.PrerenderError`, `Route.PrerenderServices`, `Route.PrerenderOptions`, `Route.PrerenderDefinition`, `Route.PrerenderConstructor`, and `Route.NoParams`.

New server-only entry `effect-frame/router/prerender`:

- `build({ routes, notFound, document, client, out, timeLimit, concurrency? })`: render every input of every prerender tree among `routes` through the router's server document, in `AwaitAll`, as `Anonymous`, at the URL `href` prints. It writes `<href>/index.html`, `client.js` (from the `client` Effect), and `manifest.json` into `out/staging/<id>`, moves it to `out/generations/<id>`, and publishes it by renaming a new `out/current.json` over the old one. A build that fails or is interrupted before that rename leaves the previous generation published. One previous generation is kept; older ones, and what crashed builds left, are removed after the pointer moves. One build writes one output: it holds `out/build.lock`, and a second build fails at once. `timeLimit` covers each page from `document(page)` on.
- `oneInstant(transport)`: the build's transport. It reads each query key, batch key, and actor snapshot once, answers every later ask from that read, and gives an empty change stream, so a page and its resume script show one revision. A failed batch fails every reader of its keys.
- Build failures: `PrerenderUnauthorized` (a query refused `Anonymous`), `PrerenderQueryFailed`, `PrerenderRedirected`, `PrerenderNotMatched`, `PrerenderTimedOut` (its `phase` includes `"document"`), `PrerenderBuildLocked { out, lock }`, `PrerenderSearchRejected { route, href }`, `PrerenderPathCollision { first, second }` (two hrefs whose files fold to one name, in NFC and lower case), and `PrerenderBrokenLink { route, href, link, target }` (a local link to a prerender route that no input built).
- `load(out)`: read the generation `current.json` names; when the pointer is missing or names no whole generation, the newest generation with a manifest. `Site.generation` is that directory, and the `Site` reads only its files. `lookup(site, pathname)` and `serve(site, fallback)`: answer a built page from its file before the router runs, with a strong `ETag` and `cache-control: public, max-age=0, must-revalidate`. The file is read first; a matching `If-None-Match` then answers 304. HEAD answers as GET does, with no body. Anything else, a page whose file cannot be read included, goes to `fallback`.
- `Manifest`, `ManifestPage`, `clientScript`, `clientFile`, `manifestFile`, `Site`, `SitePage`, `WebHandler`, `BuildOptions`, `PageDocument`, and `PrerenderManifestInvalid`.

**Breaking:**

- `Streaming.Patch` has an optional `builtAt` (milliseconds). A patch with `builtAt` lands in the query cache as `Ready { stale: true }`, and the entry reads once to confirm it; before, every seeded value landed fresh. A patch without `builtAt` is unchanged.
- `Route.Segment` has an eighth type parameter, `Inherited`, the params its ancestors add (`NoParams` for a root segment). Code that spells `Segment` with seven arguments still compiles; code that matches it with `infer` in all positions must add one.
