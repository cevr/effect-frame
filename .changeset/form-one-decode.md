---
"effect-frame": minor
---

A form body has one decode, and `View.form` proves at compile time that the post can decode.

- `Form.decode(schema)(fields)` strips the framework fields, nests the rest and decodes the message. `HttpServer.form` and a scripted `View.form` submit both run it. A body that cannot nest fails with `FormMalformed` (the route answers 400, as before); one that does not decode fails with the schema's error (the route redraws the page with its issues, as before).
- `View.form`'s `message` must be one of the contract's own members (one schema of its union, or one variant of its machine event schema), not a copy with the same type: the post decodes with the contract's schema. A copy whose `Type` matches but whose encoding differs (`Finite` where the member has `FiniteFromString`) no longer compiles.
- `View.form`'s `message` must have a form encoding (`Form.Codable`): a member with a field that does not encode to strings, or a boolean with no decoding default, no longer compiles. It used to compile and refuse every post at run time.
