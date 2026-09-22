import { Effect } from "effect";
import {
  DurableHostConfig,
  type DurableEngineOptions,
  type DurableHostSettings,
  openDurable,
} from "./durable-engine.js";
import type { Committed } from "./engine-types.js";
import { select } from "./source.js";
import type { ActorRef, Applied } from "./vocabulary.js";

const toApplied = <State>(committed: Committed<State>): Applied<State> => ({
  revision: committed.revision,
  state: committed.state,
});

/** The public durable actor options. The engine remains a private module. */
export type DurableOptions<State, Message, R> = DurableEngineOptions<State, Message, R>;

export { DurableHostConfig };
export type { DurableHostSettings };

/**
 * Spawn a durable actor over the `MailboxStore` in context. The public
 * adapter and hosted implementations both use the same private engine.
 */
export const durable = Effect.fn("Actor.durable")(function* <State, Message, R>(
  options: DurableOptions<State, Message, R>,
) {
  const engine = yield* openDurable(options);
  const applied = select(engine.committed, toApplied);
  const ref: ActorRef<State, Message, "durable"> = {
    kind: "durable",
    applied,
    state: select(applied, (committed) => committed.state),
    send: engine.send,
    call: (message, callOptions) => Effect.map(engine.call(message, callOptions), toApplied),
  };
  return ref;
});
