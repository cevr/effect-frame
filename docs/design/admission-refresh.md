# Command admission and query refresh

> Decision record: it explains a choice as of its day, and its code may be
> out of date. The reference is [the package README](../../packages/effect-frame/README.md)
> and the JSDoc.

An actor `send` acknowledges mailbox admission before behavior application can
finish. When its receipt has no committed revision, the host returns an empty
refresh list. Dependent query entries therefore remain ready and stale until
an authoritative refresh arrives.

A same-ID `call` waits for the stored receipt and returns its exact committed
projection. The host may refresh active dependent queries in that response. A
duplicate `send` with a committed receipt may also refresh those queries, but
the mailbox does not apply the message again.

The transport schemas and command identity stay unchanged. Automatic command
settlement remains a later command-handle concern. The real regression is in
`packages/effect-frame/tests/actor/admission-refresh.test.ts`.
