# North stars

Every candidate names the north star it serves, and every rejection names the north star it would break. When two north stars pull against each other, the ledger row says so and the owner decides. A sweep does not decide it.

| North star                 | It holds when                                                                                                                                                                                             | A candidate breaks it when                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Effect-native**          | Work is an `Effect`, `Stream`, or `Layer`. Lifetimes are `Scope`s. Failures are typed (`Schema.TaggedError`). Services come from `Context`. Data crosses a boundary through `Schema`.                     | It adds a Promise, a callback registry, a manual cleanup list, an untyped `throw`, a global singleton, or a hand-written decoder where Effect already has the tool. |
| **Actor-model**            | State lives in an actor behind a contract. It changes only through a message that is admitted in order and applied once. Placement (local, durable, remote) shows in the reference type, not in the view. | A view or a route writes shared state directly, a message applies twice, admission order becomes implicit, or a consumer branches on placement.                     |
| **Expressive**             | The common case reads as one short, typed declaration. The types carry the intent, so a wrong program does not compile.                                                                                   | The author repeats what the framework could infer, or a mistake that the types could catch reaches run time.                                                        |
| **Declarative**            | The author states what: routes, data a segment needs, the rendering mode, a form's message. The framework does how: fetch order, concurrency, refresh, hydration.                                         | The author has to sequence framework work, or one view needs a branch per rendering mode, host, or transport.                                                       |
| **Explicit over implicit** | A behavior that matters is visible where it is written: an ID, a scope, a placement, a mode, a policy, an allow-all. Nothing important depends on ambient globals, magic names, or call order.            | It adds a hidden default, a directive string, a convention the build cannot check, or state that a reader cannot find from the call site.                           |

## How to use them in a sweep

- A deletion that keeps every north star is the best candidate. Say which north star makes the deleted code unnecessary.
- "Expressive" never beats "explicit": shorter code that hides an ID, a scope, or a placement is rejected.
- "Declarative" never beats "actor-model": a declaration that writes shared state outside a message is rejected.
- A pattern taken from prior art is adopted only when it keeps all five. Record which north star each rejected pattern fails.
