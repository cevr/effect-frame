import { implementTransparent } from "effect-frame/actor";
import { ordersBehavior } from "./behavior.js";
import { Orders } from "./contract.js";

/**
 * The order book, hosted. A server module: a browser entry that reaches it
 * fails `bun run boundary`. The reducer is browser safe (`behavior.ts`),
 * because the page predicts a `Fulfil` with it.
 */
export const OrdersLive = implementTransparent(Orders, ordersBehavior);
