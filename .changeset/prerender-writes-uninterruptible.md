---
"effect-frame": patch
---

A prerender build writes each page, the client and the manifest uninterruptibly. Before, an interrupted or failed build could leave a staging directory behind: a page write that the build interrupted ran on in the platform and made the directory again after the staging was removed.
