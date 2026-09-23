---
"effect-frame": minor
---

A server that loaded a prerendered generation keeps its files however many builds follow. Before, a build kept only the new generation and the one before it, so after two rebuilds a running server's files were gone and every page it had built answered through the router. Now `Prerender.load` holds the generation it reads with a lease under `<out>/leases/`, and a build removes no generation a lease names. The lease goes when the scope closes, and the next build removes the generation.

Breaking: `Prerender.load` now needs a `Scope`. Run it in the scope the server lives in (for a server started with `runPromise`, a `Scope.make()` you close when the server stops). A build keeps the previous generation only while a loaded site holds it. The output directory has a new `leases/` directory beside `generations/`.
