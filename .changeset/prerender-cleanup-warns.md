---
"effect-frame": patch
---

A prerender cleanup that fails logs a warning instead of dropping the failure silently: the build lock, a failed build's staging directory, an uncommitted pointer or generation, a lease, and older generations each name what was not removed. The build's result is unchanged.
