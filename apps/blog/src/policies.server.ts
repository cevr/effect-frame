import { Policies, Policy } from "effect-frame/actor";
import { Effect, Layer, Option } from "effect";

/**
 * The one policy table (#20). `public` admits everyone, `Anonymous`
 * included, by name: the posts, the index, and the reactions name it, so a
 * prerendered page may read them. `editor` admits only a signed-in caller
 * whose claims say `role: "editor"`. `Draft` names it, so no build can put
 * a draft in a file the whole internet can read. A server module.
 */

const isEditor = Policy.of(Option.some, (principal) =>
  Effect.succeed(principal.claims["role"] === "editor"),
);

export const policies = Layer.succeed(
  Policies,
  Policies.of({
    public: Policy.allowAll,
    editor: isEditor,
  }),
);
