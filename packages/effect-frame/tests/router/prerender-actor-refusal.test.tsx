import { registerDom } from "./dom-setup.js";

registerDom();

import { ActorHost, Behavior, Policies, Policy, implementTransparent } from "effect-frame/actor";
import { contract } from "effect-frame/actor/client";
import { Route } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import { View } from "effect-frame/view";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Match, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { NotFound, tempDirectory, treeOf } from "./prerender-fixture.js";

/**
 * #23 §2.3: a prerendered page renders as `Anonymous`, and a read that
 * refuses `Anonymous` fails the build with `PrerenderUnauthorized`. That
 * holds for an actor a route declares as it does for a query: the build
 * names the route, the page and the contract, and writes nothing.
 */

const platform = it.scopedLive.layer(BunServices.layer);

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
const Snapshot = Schema.Struct({ count: Schema.Finite });
type Snapshot = Schema.Schema.Type<typeof Snapshot>;
type Message = Schema.Schema.Type<typeof Add>;

/** An actor only a signed-in principal may read. */
const Ledger = contract("PrerenderLedger", {
  version: 1,
  policy: "members",
  key: Schema.String,
  snapshot: Snapshot,
  message: Add,
});

const ledgerBehavior = Behavior.reducer<Snapshot, Message>({
  initial: { count: 0 },
  reduce: (state, message) =>
    Match.type<Message>().pipe(
      Match.tagsExhaustive({ Add: (add) => ({ count: state.count + add.amount }) }),
    )(message),
});

const store = Layer.build(
  ActorHost.layer({
    implementations: [implementTransparent(Ledger, { behavior: ledgerBehavior })],
    store: ActorHost.memoryStore,
  }).pipe(
    Layer.provide(
      Layer.succeed(
        Policies,
        Policies.of({ members: Policy.of(Option.some, () => Effect.succeed(true)) }),
      ),
    ),
    Layer.orDie,
  ),
);

const ledger = Route.segment("ledger", {
  path: "/ledgers/:key",
  params: Schema.Struct({ key: Schema.String }),
  data: ({ params }) => ({
    ledger: Route.actor(Ledger, params.key, { behavior: ledgerBehavior }),
  }),
});

const ledgerRoute = Route.prerender(
  "ledgers",
  Route.leaf(ledger, (props) =>
    Effect.map(props.data.ledger.ref.get, (opened) => (
      <p id="count">{View.bind(opened.state, (state) => state.count)}</p>
    )),
  ),
  { inputs: [Route.inputs(ledger, Effect.succeed([{ key: "l1" }]))] },
);

describe("a prerendered page that declares a protected actor (#23 §2.3)", () => {
  platform(
    "fails the build with PrerenderUnauthorized naming the actor's contract, and writes nothing",
    () =>
      Effect.gen(function* () {
        const side = yield* store;
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        const exit = yield* Effect.exit(
          Prerender.build({
            routes: [ledgerRoute],
            notFound: NotFound,
            document: () => Effect.succeed({ head: "", rootId: "app", tail: "", end: "" }),
            client: Effect.succeed("export {};"),
            out,
            timeLimit: "5 seconds",
          }).pipe(Effect.provideContext(side)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject({
          _tag: "PrerenderUnauthorized",
          route: "ledgers",
          href: "/ledgers/l1",
          read: "actor",
          contract: "PrerenderLedger",
        });
        expect(yield* treeOf(out)).toEqual([]);
      }),
  );
});
