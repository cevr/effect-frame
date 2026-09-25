---
"effect-frame": minor
---

Add `View.show({ when, content, fallback? })` and `View.match(on, cases)`: a branch whose content runs a setup. The setup runs each time the branch is shown, and its scope closes when the branch hides, so a hidden branch holds no actor, follows no query and observes no source. `View.match` takes one setup per tag and is exhaustive, as `<Match>` is; a new value under the same tag reaches the case through its source without running the setup again. Both are built on `View.keyed`.
