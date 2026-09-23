import { implementTransparent } from "effect-frame/actor";
import { alertsBehavior, memoBehavior } from "./behavior.js";
import { Alerts, Memo } from "./contract.js";

/**
 * The alerts, hosted: the one live stream the overview follows. The memo
 * lives beside them; no query depends on it. Server modules.
 */
export const AlertsLive = implementTransparent(Alerts, alertsBehavior);

export const MemoLive = implementTransparent(Memo, memoBehavior);
