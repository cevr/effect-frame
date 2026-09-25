import { implementTransparent } from "effect-frame/actor";
import { Behavior, Refused } from "effect-frame/actor/client";
import { Option } from "effect";
import { memoBehavior } from "./behavior.js";
import { Alerts, Memo, alertsMachine, pinnedAlert } from "./contract.js";

/**
 * The alerts, hosted: the machine the overview follows as its one live
 * stream. One alert is pinned: an `Ack` of it is refused before admission,
 * so its handle settles `Rejected` and nothing commits. The memo lives
 * beside them; no query depends on it. Server modules.
 */
export const AlertsLive = implementTransparent(Alerts, {
  behavior: Behavior.machine(alertsMachine, {
    refuse: (ack) =>
      Option.as(
        Option.liftPredicate(ack, (one) => one.id === pinnedAlert),
        Refused.make({ reason: "pinned" }),
      ),
  }),
});

export const MemoLive = implementTransparent(Memo, { behavior: memoBehavior });
