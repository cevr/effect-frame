---
"effect-frame": patch
---

The `MailboxStore` conformance suite in `effect-frame/actor/testing` has two new cases. "a seen command ID is never admitted again" re-sends a committed ID after later commands and an advance and requires `Duplicate` with the first admission and its receipt, no pending entry, and no admission number spent. "a receipt outlives the retry bound" re-sends and reads the receipt once per pass of the 8-pass bound while other commands and autonomous changes commit, then requires the same receipt for a manual retry. A store that prunes receipts or re-admits a seen ID now fails the suite.
