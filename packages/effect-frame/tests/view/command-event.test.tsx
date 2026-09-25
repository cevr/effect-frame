import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorHost,
  MailboxStore,
  implementTransparent,
  Policies,
  Policy,
} from "effect-frame/actor";
import { ActorTransport, contract, ref, Source } from "effect-frame/actor/client";
import type { TransportService } from "effect-frame/actor/client";
import { Dom, View, ViewTest, mount } from "effect-frame/view";
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import * as Frame from "../../src/frame.js";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const Counter = contract("CommandEventCounter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Finite,
});

/** Each turn waits on a real timer, so a starved scheduler would never finish it. */
const CounterLive = implementTransparent(Counter, {
  initial: 0,
  open: () =>
    Effect.succeed({
      apply: (state: number, amount: number) =>
        Effect.as(Effect.sleep("30 millis"), state + amount),
      changes: Stream.empty,
    }),
});

interface Requests {
  readonly sends: number;
  readonly calls: number;
}

const requests = Ref.makeUnsafe<Requests>({ sends: 0, calls: 0 });

/** The real in-process host behind an asynchronous hop on every request. */
const delayedTransport = Effect.gen(function* () {
  const real = yield* ActorHost.make({
    implementations: [CounterLive],
    store: () => MailboxStore.layerMemory,
  });
  const transport: TransportService = {
    ...real,
    send: (address, commandId, payload, active) =>
      Ref.update(requests, (seen) => ({ ...seen, sends: seen.sends + 1 })).pipe(
        Effect.andThen(Effect.sleep("20 millis")),
        Effect.andThen(real.send(address, commandId, payload, active)),
      ),
    call: (address, commandId, payload, timeout, active) =>
      Ref.update(requests, (seen) => ({ ...seen, calls: seen.calls + 1 })).pipe(
        Effect.andThen(Effect.sleep("20 millis")),
        Effect.andThen(real.call(address, commandId, payload, timeout, active)),
      ),
  };
  return transport;
});

const appLayer = ActorTransport.layerLocal(delayedTransport).pipe(
  Layer.provide(policies),
  Layer.provideMerge(Frame.layer({ name: "command-event" })),
);

interface NoProps {
  readonly _tag: "NoProps";
}

/** The click handler only starts the command. It returns before any reply. */
const Clicker = (_props: NoProps) =>
  Effect.gen(function* () {
    const counter = yield* ref(Counter, "one");
    return (
      <div>
        <span id="count">{View.bind(Source.select(counter.state, (n) => String(n)))}</span>
        <button id="add" onClick={View.event(() => Effect.asVoid(counter.send(1)))}>
          add
        </button>
      </div>
    );
  });

const textAt = (root: Node, selector: string): string => {
  if (root instanceof HTMLElement) {
    return Option.getOrElse(
      Option.fromNullishOr(root.querySelector(selector)?.textContent),
      () => "",
    );
  }
  return "";
};

describe("a command started by a view event", () => {
  it.scopedLive.layer(appLayer)(
    "outlives the event, runs on the mount scheduler, and applies once",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.sync(() => document.createElement("main"));
        const page = yield* ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) => mount(Clicker, { _tag: "NoProps" }, host, mountRoot),
        });
        expect(textAt(root, "#count")).toBe("0");

        yield* Effect.sync(() => root.querySelector("#add")?.dispatchEvent(new Event("click")));
        // The event fiber has returned. The command is retained and running
        // on the reference's owner, not on the event.
        const during = yield* Frame.inspect;
        expect(during.commands.records).toEqual([
          expect.objectContaining({ kind: "remote", identity: "fresh", running: true }),
        ]);

        yield* page.act(Effect.void, {
          label: "the event-started command applies",
          until: (actualRoot) => textAt(actualRoot, "#count") === "1",
        });
        expect(textAt(root, "#count")).toBe("1");
        // One healthy pass: one send and one same-ID call.
        expect(yield* Ref.get(requests)).toEqual({ sends: 1, calls: 1 });
        yield* Effect.repeat(Frame.inspect, {
          until: (snapshot) => snapshot.commands.records.length === 0,
        });
        yield* page.close;
      }),
  );
});
