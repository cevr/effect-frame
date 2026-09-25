import type { KeyOf } from "effect-frame/actor/client";
import { Actor } from "effect-frame/actor/client";
import { View } from "effect-frame/view";
import { Effect } from "effect";
import { Counter, Increment } from "../counter/contract.js";

export type RoomKey = KeyOf<typeof Counter>;

/**
 * A driven view draws from its one drive actor, on both sides, and from its
 * props. Any other read fails `Unreachable`.
 */
export const RoomView = (props: { readonly key: RoomKey }) =>
  Effect.gen(function* () {
    const room = yield* Actor.remote(Counter, props.key);
    const add = View.event(Effect.asVoid(room.send(Increment.make({ by: 1 }))));
    return (
      <section>
        <p>count: {View.bind(room.state)}</p>
        <button type="button" onClick={add}>
          add
        </button>
      </section>
    );
  });
