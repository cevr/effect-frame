---
"effect-frame": patch
---

`Form.codec` accepts an effect-machine event schema (#105). Before, `Form.codec(contract.raw.message)` did not compile for a machine contract, because its message schema names `variants`, not `members`. Each variant is now checked as a union member is: a machine event whose fields all encode to strings builds a form codec, and one with a `Uint8Array` field, or a boolean with no decoding default, is still a compile error.
