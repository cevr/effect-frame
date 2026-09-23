---
"effect-frame": patch
---

A mailbox store no longer takes a different payload under a used command ID for a `Duplicate` when the two payload hashes are equal. `MailboxStore.layerMemory` compares the stored payload text once the hashes match, and answers `CommandConflict` when the text differs. `Hash.string` gives `{"title":"00008t"}` and `{"title":"0000fj"}` one hash, so before this fix a second message under one ID could be read as a retry of the first. The store conformance suite has a new case, "a new payload with an equal hash under a used ID fails with CommandConflict". A custom `MailboxStore` must compare the payload text too.
