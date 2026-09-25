import { Dom, Remote } from "effect-frame/view";
import { Effect, Schema } from "effect";
import { Counter } from "../counter/contract.js";
import type { RoomKey } from "./driven.js";
import { RoomView } from "./driven.js";

const decodePatch = Schema.decodeEffect(Remote.PatchJson);

// #region client
// The client draws from the snapshot on its own recorder, then applies each
// patch. It works with any host; here, the DOM.
export const follow = (key: RoomKey, root: Element, send: (event: Remote.RemoteEvent) => void) => {
  const client = Remote.client(
    RoomView,
    { key },
    { contract: Counter, key },
    {
      host: Dom.host,
      root,
      send,
    },
  );
  return {
    // The first connect and every reconnect.
    resume: (payload: string) => client.resume(payload),
    // A patch from another session, one out of order, or one naming a node
    // the client does not hold applies nothing and fails.
    apply: (text: string) => Effect.flatMap(decodePatch(text), client.apply),
  };
};
// #endregion client
