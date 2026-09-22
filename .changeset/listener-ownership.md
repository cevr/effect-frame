---
"effect-frame": patch
---

Release host event listeners with the branch, row, and mount scope that owns their element. Start view work only after that owner accepts it, so a closed owner cannot start stale handlers or attachment setup.
