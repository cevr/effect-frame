import { Remote } from "effect-frame/view";
import * as Driven from "effect-frame/view/driven";
import { Effect, Schema, Stream } from "effect";
import { Counter } from "../counter/contract.js";
import type { RoomKey } from "./driven.js";
import { RoomView } from "./driven.js";

const encodePatch = Schema.encodeEffect(Remote.PatchJson);

// #region server
// One session per connection. The socket is the application's: `received`
// is the events the client sent, and `send` writes one text frame.
export const serve = (
  key: RoomKey,
  received: Stream.Stream<Remote.RemoteEvent>,
  send: (text: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const session = yield* Driven.session(RoomView, { key }, { contract: Counter, key });
    // The first message is the drive's snapshot, never an operation log.
    yield* send(session.resume);
    yield* Effect.forkScoped(Stream.runForEach(received, session.fire));
    yield* Stream.runForEach(session.patches, (patch) => Effect.flatMap(encodePatch(patch), send));
  });
// #endregion server
