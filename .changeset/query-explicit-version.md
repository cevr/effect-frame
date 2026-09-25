---
"effect-frame": minor
---

`query` and `query.batched` require `version` and `depends`, as `contract` requires its `version`. `version` used to default to 1 and `depends` to none, so a forgotten `depends` compiled and no commit ever marked the query stale. Write `version: 1` and `depends: []` where you meant the old defaults.
