import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, Behavior, Value } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { Dom, View } from "effect-frame/view";
import type { ScopesClosed } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * `View.show` and `View.match` run a branch's setup only while the branch
 * is drawn. A hidden branch runs nothing and observes nothing: its setup
 * has not run, and a branch that hides closes the scope its setup opened,
 * with every subscription in it.
 */

/** What a branch did: how often its setup ran and closed, and its open subscriptions. */
interface Probe {
  setups: number;
  closes: number;
  open: number;
}

const makeProbe = (): Probe => ({ setups: 0, closes: 0, open: 0 });

/** A source whose subscriptions the probe counts while they are open. */
const counted = <A,>(inner: Source<A>, probe: Probe): Source<A> => ({
  get: inner.get,
  changes: Stream.unwrap(
    Effect.sync(() => {
      probe.open += 1;
      return inner.changes;
    }),
  ).pipe(
    Stream.ensuring(
      Effect.sync(() => {
        probe.open -= 1;
      }),
    ),
  ),
});

/** A branch's setup: it counts its run, its close, and binds a counted source. */
const Region = <A,>(probe: Probe, text: Source<A>, show: (value: A) => string) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      probe.setups += 1;
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        probe.closes += 1;
      }),
    );
    return <p id="region">{View.bind(counted(text, probe), show)}</p>;
  });

const makeRoot = Effect.sync(() => document.createElement("main"));

const textAt = (root: Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return root.querySelector(selector)?.textContent ?? "";
};

const pageMount = <Props, E, R>(
  root: Node,
  view: View.View<Props, E, R> & ScopesClosed<R>,
  props: Props,
) =>
  ViewTest.make({
    host: Dom.host,
    root,
    setup: (host, mountRoot) => View.mount(view, props, host, mountRoot),
  });

interface ShowPageProps {
  readonly when: Source<boolean>;
  readonly label: Source<string>;
  readonly probe: Probe;
}

const ShowPage = (props: ShowPageProps) =>
  Effect.gen(function* () {
    const region = yield* View.show({
      when: props.when,
      content: Region(props.probe, props.label, (label) => label),
      fallback: Effect.succeed(<p id="empty">empty</p>),
    });
    return <section>{region}</section>;
  });

type Pane = { readonly _tag: "Idle" } | { readonly _tag: "Asked"; readonly q: string };

interface MatchPageProps {
  readonly pane: Source<Pane>;
  readonly probe: Probe;
}

const MatchPage = (props: MatchPageProps) =>
  Effect.gen(function* () {
    const body = yield* View.match(props.pane, {
      Idle: () => Effect.succeed(<p id="idle">no query yet</p>),
      Asked: (asked) => Region(props.probe, asked, (value) => value.q),
    });
    return <section>{body}</section>;
  });

describe("View.show and View.match", () => {
  it.scoped("a hidden branch has not run its setup, and hiding it closes its scope", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const probe = makeProbe();
      const when = yield* Actor.local(Behavior.value(false));
      const label = yield* Actor.local(Behavior.value("first"));
      const page = yield* pageMount(root, ShowPage, {
        when: when.state,
        label: label.state,
        probe,
      });
      expect(textAt(root, "#empty")).toBe("empty");
      expect(probe).toEqual({ setups: 0, closes: 0, open: 0 });

      yield* page.act(when.call(Value.Set(true)), {
        label: "the branch is shown",
        until: (actual) => textAt(actual, "#region") === "first" && probe.open === 1,
      });
      expect(probe).toEqual({ setups: 1, closes: 0, open: 1 });

      yield* page.act(label.call(Value.Set("second")), {
        label: "the shown branch follows its source",
        until: (actual) => textAt(actual, "#region") === "second",
      });
      expect(probe.setups).toBe(1);

      yield* page.act(when.call(Value.Set(false)), {
        label: "the branch hides and its subscription closes",
        until: (actual) => textAt(actual, "#empty") === "empty" && probe.open === 0,
      });
      expect(textAt(root, "#region")).toBe("");
      expect(probe).toEqual({ setups: 1, closes: 1, open: 0 });
    }),
  );

  it.scoped("a case runs its setup once per tag, and a new tag closes the old case", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const probe = makeProbe();
      const pane = yield* Actor.local(Behavior.value<Pane>({ _tag: "Idle" }));
      const page = yield* pageMount(root, MatchPage, { pane: pane.state, probe });
      expect(textAt(root, "#idle")).toBe("no query yet");
      expect(probe).toEqual({ setups: 0, closes: 0, open: 0 });

      yield* page.act(pane.call(Value.Set<Pane>({ _tag: "Asked", q: "grace" })), {
        label: "the Asked case is drawn",
        until: (actual) => textAt(actual, "#region") === "grace" && probe.open === 1,
      });
      expect(probe).toEqual({ setups: 1, closes: 0, open: 1 });

      yield* page.act(pane.call(Value.Set<Pane>({ _tag: "Asked", q: "faith" })), {
        label: "a new value under the same tag updates in place",
        until: (actual) => textAt(actual, "#region") === "faith",
      });
      expect(probe.setups).toBe(1);

      yield* page.act(pane.call(Value.Set<Pane>({ _tag: "Idle" })), {
        label: "the Idle case replaces Asked",
        until: (actual) => textAt(actual, "#idle") === "no query yet" && probe.open === 0,
      });
      expect(probe).toEqual({ setups: 1, closes: 1, open: 0 });
    }),
  );
});
