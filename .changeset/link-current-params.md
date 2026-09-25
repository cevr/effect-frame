---
"effect-frame": patch
---

`link` compares its own params with the current URL: `aria-current="page"` now marks only the link whose printed path is the current path, and `aria-current="true"` only a link whose printed path the current path continues below. Before, every link to the same segment was current whatever its params, so a list of `/counters/:name` links all carried `aria-current="page"`. The search never counts. `Linkable.currentAt` takes the link's params.
