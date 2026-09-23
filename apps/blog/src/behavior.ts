import { Behavior } from "effect-frame/actor/client";
import type { Heart, ReactionsSnapshot } from "./contract.js";

/**
 * The reactions behavior: a heart adds one row. Browser safe, so the host
 * runs it and the post page predicts with it: a heart the client mints
 * shows at once.
 */
export const reactionsBehavior = Behavior.reducer<ReactionsSnapshot, Heart>({
  initial: { hearts: 0, ids: [] },
  reduce: (state, heart) => ({ hearts: state.hearts + 1, ids: [...state.ids, heart.id] }),
});
