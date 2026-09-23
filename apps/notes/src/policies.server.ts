import { Policies, Policy } from "effect-frame/actor";
import { Layer } from "effect";

/**
 * The one policy table (#20). Notes has no sessions and no tenants, so
 * `public` is allow-all, and it is written here by name rather than
 * assumed. The contract and both queries name it.
 */
export const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));
