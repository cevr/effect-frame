import { Policies, Policy, Unauthorized } from "effect-frame/actor";
import type { Subject } from "effect-frame/actor";
import { Effect, Layer, Option, Schema } from "effect";
import { NotesKey, readOnlyList } from "./contract.js";

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

const decodeKey = Schema.decodeUnknownOption(Schema.fromJsonString(NotesKey));

const readOnly = (subject: Subject): boolean =>
  subject._tag === "Actor" &&
  Option.exists(decodeKey(subject.address.key), (key) => key.list === readOnlyList);

const sendsToWritableLists: Policy = {
  check: (_principal, subject) => {
    if (readOnly(subject)) {
      return Effect.fail(Unauthorized.make({ contract: "Notes" }));
    }
    return Effect.void;
  },
};

export const policies = Layer.succeed(
  Policies,
  Policies.of({
    public: Policy.allowAll,
    notes: Policy.byAction({ read: Policy.allowAll, send: sendsToWritableLists }),
  }),
);
