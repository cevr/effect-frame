---
"effect-frame": major
---

`attachGateway` returns `{ status }`, a `Stream` of `AttachStatus`, in place of the `onStatus` callback. It takes a required `retry: Schedule` and `openTimeout: Duration.Input` in place of `initialRetryMillis`, `maxRetryMillis` and `openTimeoutMillis`; `defaultRetry` (250 ms doubling to 5 s) and `defaultOpenTimeout` (2 s) name the old defaults. A schedule that ends stops the attachment with a new `Stopped` status.
