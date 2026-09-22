---
"effect-frame": patch
---

Fix keyed list reorder when rows swap. A moved row could anchor on a row that moved later, so a swap left rows out of order. A reorder now keeps the longest run of rows already in order and moves only the others, walking backwards so each anchor is already in its final place.
