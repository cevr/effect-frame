import { Actor, Behavior } from "effect-frame/actor/client";
import { Html } from "effect-frame/view";
import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { Hit } from "../../examples/features/branches.js";
import { Reference } from "../../examples/features/branches.js";

/**
 * The README's flat union `Match` (`examples/features/branches.tsx`): one
 * source of a tagged union draws each of its three cases.
 */

const draw = (hit: Hit) =>
  Effect.gen(function* () {
    const source = yield* Actor.local(Behavior.value(hit));
    return yield* Html.renderToString(Reference, { hit: source.state });
  });

describe("the union Match example", () => {
  it.scoped("draws a missing, a plain and a linked citation", () =>
    Effect.gen(function* () {
      const missing = yield* draw({ refcode: Option.none(), url: Option.none() });
      const plain = yield* draw({ refcode: Option.some("DA 1.1"), url: Option.none() });
      const linked = yield* draw({
        refcode: Option.some("DA 1.1"),
        url: Option.some("https://example.test/da/1"),
      });
      expect(missing).toContain('<span class="refcode"></span>');
      expect(plain).toContain('<span class="refcode">DA 1.1</span>');
      expect(linked).toContain('<a class="refcode" href="https://example.test/da/1">DA 1.1</a>');
    }),
  );
});
