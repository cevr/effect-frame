---
"effect-frame": minor
---

A plain form post now answers 303 after its command commits, not when it is admitted. Before, the page the browser read next could still draw the state from before the post: a multi-step form with no script could show the step it had just left. The form route now calls the host and waits for the commit, so the commit is readable before the 303, and a `$return` page rendered on request draws it (#21 §5). A prerendered page is a file, and shows the commit after it hydrates. A commit that does not come within `commitWithin`, or a host that does not answer in that time, answers 504 with the same `$command`, and the identical resubmit reaches the stored receipt. `HttpServer.form` takes `commitWithin` (default ten seconds).
