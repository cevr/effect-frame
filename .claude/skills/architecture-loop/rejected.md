# Rejected candidates

A sweep re-proposes one of these only with a new receipt. The full reasons are the ledger rows in `plans/architecture-loop-*.md`.

| Candidate                                                          | Why it stays                                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything that changes a wire or stored format                      | The inspection protocol version, the resume payload, the mailbox store, the form field names. Rejected by default; it needs an owner decision and a migration. |
| Re-opening a closed design ticket                                  | The decision on the closed issue stands. A sweep brings a new receipt (a failing test or a reproduced defect), not a preference.                               |
| A change to a row in `docs/design/acceptance.md` without its test  | The matrix is proof, not prose. A row moves only with the test that proves it.                                                                                 |
| Ternaries, nullish values, async functions, `new Promise` in `src` | The oxlint effect rules forbid them. A candidate that needs them is the wrong candidate.                                                                       |
