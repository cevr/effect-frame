import { Policies, Policy } from "effect-frame/actor";
import { Effect, Layer } from "effect";
import { Notes, readOnlyList } from "./contract.js";

/**
 * The one policy table (#20). Notes has no sessions and no tenants, so
 * `public` is allow-all, and it is written here by name rather than
 * assumed. Both queries name it.
 *
 * `notes` is the notes actor's rule: any caller reads any list, and a send
 * to the read-only list is refused. It is server-only, so the page cannot
 * foresee it: the page predicts the send, and the host's refusal takes the
 * predicted row back (#19, #37).
 */

/** A send to the notes actor names a writable list. */
const sendsToWritableLists = Policy.forSubjects(
  { contracts: [Notes], queries: [] },
  (_principal, key) => Effect.succeed(key.list !== readOnlyList),
);

export const policies = Layer.succeed(
  Policies,
  Policies.of({
    public: Policy.allowAll,
    notes: Policy.byAction({ read: Policy.allowAll, send: sendsToWritableLists }),
  }),
);
