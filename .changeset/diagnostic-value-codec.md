---
"effect-frame": patch
---

Type `Frame.DiagnosticValue` as a `Schema.Codec`, not a `Schema.Schema`. A `Frame.Snapshot` schema then has no unknown encoding or decoding services, so a typed encode, decode, or RPC schema of a snapshot type checks. The runtime schema is unchanged.
