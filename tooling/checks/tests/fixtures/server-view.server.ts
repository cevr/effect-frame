import { shared } from "./shared-view.js";

/** A server view that nests an ordinary child view. Imports point one way. */
export const serverView = `server:${shared}`;
