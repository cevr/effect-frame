---
"effect-frame": patch
---

A keyed list (`For`, `View.list`) now moves only the rows whose position changed. Before, every emission re-inserted every row's nodes, which moved them in the document and dropped focus, selection, and scroll inside a row that had not moved.
