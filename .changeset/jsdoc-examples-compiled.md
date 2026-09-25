---
"effect-frame": patch
---

Every `@example` in the JSDoc is now a region of a compiled file, and five that no longer compiled are corrected: `Actor.remote` and `Actor.remoteCommands` take the contract's key struct, `Generated.send` takes the decoded message, `implementTransparent`'s example uses the counter's own behavior, and a `before` check calls its sign-in read with the tenant. The internal form decoder's example, which showed a call no app can make, is gone.
