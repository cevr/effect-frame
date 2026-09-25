import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor/client";
import { Route } from "effect-frame/router";
import type { Route as RouteTypes } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect, Option, Predicate, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { describe, expect, it } from "effect-bun-test";
import { ListName } from "../src/queries.js";
import { routes } from "../src/routes.js";
import {
  IndexSearch,
  ListParams,
  ListSearch,
  NoParams,
  home,
  index,
  list,
  lists,
  print,
  scratch,
  shell,
} from "../src/segments.js";
import { has, mountApp, settle, tappedHost, textOf } from "./fixture.js";

/**
 * #18 in the app: every Notes segment prints what it parses, a search
 * change is a `stayed` transition that moves only the changed key, and a
 * template that cannot print is refused where it is written.
 */

const origin = "http://notes.test";
const inbox = Schema.decodeSync(ListName)("inbox");

// ---------------------------------------------------------------------------
// A route prints what it parses, for every route in the tree
// ---------------------------------------------------------------------------

/** A decoded value as JSON text, for comparing what the router parsed. */
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A probe leaf: it draws the params and search the router decoded, as
 * JSON, beside the name of the segment that matched. The probe tree holds
 * the app's own segments, so the router parses with the app's codecs.
 */
const probe =
  (name: string) =>
  (props: { readonly params: Source<unknown>; readonly search: Source<unknown> }) =>
    Effect.succeed(
      <section id="probe" data-segment={name}>
        <pre id="params">{View.bind(props.params, asJson)}</pre>
        <pre id="search">{View.bind(props.search, asJson)}</pre>
      </section>,
    );

const ShellProbe = <ChildR,>(props: RouteTypes.LayoutPropsOf<typeof shell, ChildR>) => props.outlet;
const ListsProbe = <ChildR,>(props: RouteTypes.LayoutPropsOf<typeof lists, ChildR>) => props.outlet;

const probeTree = Route.client(
  "probe",
  Route.layout(
    shell,
    [
      Route.layout(
        lists,
        [
          Route.leaf(index, probe("index")),
          Route.leaf(list, probe("list")),
          Route.leaf(print, probe("print")),
        ],
        ListsProbe,
      ),
      Route.leaf(scratch, probe("scratch")),
    ],
    ShellProbe,
  ),
);

const isRejected = Schema.is(Route.UrlValueRejected);

/** Values as a URL carries them: path texts, and each search key's texts. */
interface Encoded {
  readonly params: Route.PathRecord;
  readonly search: Route.SearchRecord;
}
const loneSurrogate = /\p{Cs}/u;
const segmentInDomain = (value: string) =>
  value !== "" && value !== "." && value !== ".." && !loneSurrogate.test(value);

/**
 * The route domain (docs/design/route-data.md, decision 13): a list name is
 * a path segment, so it is well-formed text that is not empty, `.` or `..`;
 * a search value is well-formed text.
 */
/** An encoded path or search value: one text, or a list of them. */
const texts = (value: string | ReadonlyArray<string>): ReadonlyArray<string> => {
  if (Predicate.isString(value)) {
    return [value];
  }
  return value;
};

/** An encoded search holds each key's values as a list (`Route.SearchRecord`). */
const inDomain = (encoded: Encoded): boolean =>
  Object.values(encoded.params).every((value) => texts(value).every(segmentInDomain)) &&
  Object.values(encoded.search).every((value) =>
    texts(value).every((text) => !loneSurrogate.test(text)),
  );

/** The href, or None when `href` died with `UrlValueRejected`. */
const printed = (printHref: () => string): Effect.Effect<Option.Option<string>> =>
  Effect.map(Effect.sync(printHref), Option.some).pipe(
    Effect.catchDefect((defect) => {
      if (isRejected(defect)) {
        return Effect.succeed(Option.none<string>());
      }
      return Effect.die(defect);
    }),
  );

interface Values {
  readonly params: unknown;
  readonly search: unknown;
}

/**
 * One page segment's property: over its own codecs, `href` either refuses
 * or prints a URL the router parses back to the same values, on this
 * segment.
 */
const roundTrip = <V extends Values, E extends Encoded>(
  name: string,
  values: Schema.Codec<V, E>,
  href: (drawn: V) => string,
) =>
  it.scopedLive(
    `the router parses ${name}'s href back to the same values, or href refuses`,
    () =>
      Effect.gen(function* () {
        const wire = yield* tappedHost;
        const app = yield* mountApp({
          transport: wire.transport,
          href: `${origin}/scratch`,
          routes: [probeTree],
        });
        const encode = Schema.encodeEffect(values);
        const on = () => has(app.root, `#probe[data-segment="${name}"]`);
        const result = yield* Arbitrary.checkEffect(
          Arbitrary.schema(Schema.toType(values)),
          (drawn) =>
            Effect.gen(function* () {
              const encoded = yield* Effect.orDie(encode(drawn));
              const printedHref = yield* printed(() => href(drawn));
              if (!inDomain(encoded)) {
                // Outside the domain, href is the defect, never a wrong URL.
                return Option.isNone(printedHref);
              }
              if (Option.isNone(printedHref)) {
                return false;
              }
              yield* app.router.navigate(printedHref.value);
              const expected = `${asJson(drawn.params)}\n${asJson(drawn.search)}`;
              const parsed = () => `${textOf(app.root, "#params")}\n${textOf(app.root, "#search")}`;
              const same = Effect.sync(() => on() && parsed() === expected);
              // A wrong parse never settles; the property then reports it.
              yield* Effect.ignore(settle(same, `${printedHref.value} parsed as ${name}`), {
                log: false,
              });
              return yield* same;
            }),
          { runs: 60, seed: 37 },
        );
        expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
      }),
    60_000,
  );

const outsideDomain = ["", ".", ".."].map((name) => Schema.decodeSync(ListName)(name));
const reserved = Schema.decodeSync(ListName)("a/b?c#d");

describe("every Notes route prints what it parses (#18)", () => {
  roundTrip("index", Schema.Struct({ params: NoParams, search: IndexSearch }), (drawn) =>
    index.href({}, drawn.search),
  );
  roundTrip("list", Schema.Struct({ params: ListParams, search: ListSearch }), (drawn) =>
    list.href(drawn.params, drawn.search),
  );
  roundTrip("print", Schema.Struct({ params: ListParams, search: ListSearch }), (drawn) =>
    print.href(drawn.params, drawn.search),
  );
  roundTrip("scratch", Schema.Struct({ params: NoParams, search: Schema.Struct({}) }), () =>
    scratch.href({}, {}),
  );

  it.effect("home prints / and a list name outside the domain is refused, never misprinted", () =>
    Effect.gen(function* () {
      expect(home.href({}, {})).toBe("/");
      for (const name of outsideDomain) {
        expect(yield* printed(() => list.href({ list: name }, {}))).toEqual(Option.none());
      }
      // Inside it, reserved characters print escaped and parse back.
      expect(list.href({ list: reserved }, { filter: "done" })).toBe(
        "/lists/a%2Fb%3Fc%23d?filter=done",
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// A search change is a stayed transition that moves only the changed key
// ---------------------------------------------------------------------------

describe("?filter=done on the list page (#18)", () => {
  it.scopedLive(
    "re-derives ListCounts only: the page and the notes body stay, and the notes actor is not read again",
    () =>
      Effect.gen(function* () {
        const wire = yield* tappedHost;
        const app = yield* mountApp({
          transport: wire.transport,
          href: `${origin}/lists/inbox`,
          routes,
        });
        yield* settle(
          Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"),
          "counts",
        );
        const page = app.root.querySelector("#list-page");
        const body = app.root.querySelector("#notes-page");
        const skeletons: Array<string> = [];
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
              if (node instanceof Element && (node.id === "skeleton" || has(node, "#skeleton"))) {
                skeletons.push("skeleton");
              }
            }
          }
        });
        observer.observe(app.root, { childList: true, subtree: true });

        yield* app.router.navigate(list.href({ list: inbox }, { filter: "done" }));
        yield* settle(
          Effect.sync(() => wire.readsOf('ListCounts{"filter":"done","list":"inbox"}') === 1),
          "the filtered counts read",
        );
        yield* settle(
          Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"),
          "counts",
        );
        observer.disconnect();

        // The same nodes: ListView and the notes body were not set up again.
        expect(app.root.querySelector("#list-page")).toBe(page);
        expect(app.root.querySelector("#notes-page")).toBe(body);
        // The route kept its actor: its snapshot was read once, on entry.
        expect(wire.snapshots.filter((one) => one.startsWith("Notes"))).toHaveLength(1);
        // Two queries, no more: only the counts key moved.
        expect(new Set(wire.reads.map((one) => one.slice(0, one.indexOf("{"))))).toEqual(
          new Set(["ListIndex", "ListCounts"]),
        );
        expect(wire.readsOf('ListCounts{"list":"inbox"}')).toBe(1);
        expect(skeletons).toEqual([]);
        expect((yield* app.current).search).toBe("?filter=done");
      }),
  );
});

// ---------------------------------------------------------------------------
// A template that cannot print is refused where it is written
// ---------------------------------------------------------------------------

const isTemplateRejected = Schema.is(Route.TemplateRejected);

/**
 * The template and reason a definition was refused with. A definition that
 * returns fails the test, and so does one that throws anything else.
 */
const refusalOf = (define: () => void) =>
  Effect.flip(Effect.try({ try: define, catch: Option.liftPredicate(isTemplateRejected) })).pipe(
    Effect.map(Option.map((refused) => ({ template: refused.template, reason: refused.reason }))),
  );

describe("a Notes segment whose template cannot print (#18)", () => {
  it.effect("a regexp group throws at definition", () =>
    Effect.gen(function* () {
      expect(
        yield* refusalOf(() =>
          Route.child(lists, "numbered", { path: ":list(\\d+)", params: ListParams }),
        ),
      ).toEqual(
        Option.some({
          template: ":list(\\d+)",
          reason: "a regexp group cannot print; refine the param's Schema instead",
        }),
      );
    }),
  );

  it.effect("a bare * throws at definition", () =>
    Effect.gen(function* () {
      expect(
        yield* refusalOf(() => Route.child(lists, "anything", { path: "*", params: NoParams })),
      ).toEqual(
        Option.some({ template: "*", reason: "an unnamed wildcard has no name to print from" }),
      );
    }),
  );
});
