---
"effect-frame": minor
---

`commandRef(contract, key)` is a remote reference that only sends. It reads no snapshot and opens no change stream, so a page that commands an actor it does not draw holds no live stream for it. Its `send` and `call` go through the same command owner a full `ref` uses: the same identities, retries and receipts, and the reply refreshes the page's active dependents in one round trip. It never predicts.
