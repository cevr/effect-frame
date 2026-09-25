---
"effect-frame": minor
---

`QueryCache.layer` provides its command ownership and streamed-document access as a second, private service in Context instead of module-global WeakMaps. A custom or wrapped `QueryCache` owns no command's dependents: it is no longer invalidated when a command starts.
