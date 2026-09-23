import { Form, contract } from "effect-frame/actor/client";
import { Effect, Exit, Option, Random, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { AddTask, Tasks, TasksMessage, board } from "../plain-form-fixture.js";

/**
 * The form codec (#21 §1.3, §1.4) and the generated-field rule (#32). One
 * message schema reads a JSON string and a flat field map to one type, and
 * decoding never invents a value.
 */

const Move = Schema.TaggedStruct("Move", {
  to: Schema.Struct({ x: Schema.FiniteFromString, y: Schema.FiniteFromString }),
  tags: Schema.Array(Schema.String),
});

const Board = contract("Board", {
  version: 1,
  key: Schema.Struct({ tenant: Schema.String, place: Schema.Struct({ room: Schema.String }) }),
  snapshot: Schema.Finite,
  message: Schema.Union([Move]),
});

const fields = (entries: ReadonlyArray<readonly [string, string]>) => Form.fromEntries(entries);

describe("form codec", () => {
  it.effect("the same contract decodes a nested key and message from a flat field map", () =>
    Effect.gen(function* () {
      const form = Form.codec(Board.raw.message);
      const fromForm = yield* Schema.decodeEffect(form)(
        fields([
          ["_tag", "Move"],
          ["to.x", "3"],
          ["to.y", "4"],
          ["tags[]", "a"],
          ["tags[]", "b"],
        ]),
      );
      const fromJson = yield* Schema.decodeEffect(Board.message)(
        '{"_tag":"Move","to":{"x":"3","y":"4"},"tags":["a","b"]}',
      );
      expect(fromForm).toEqual({ _tag: "Move", to: { x: 3, y: 4 }, tags: ["a", "b"] });
      expect(fromForm).toEqual(fromJson);

      // No field name carries a type: coercion lives in the schema.
      const encoded = yield* Schema.encodeEffect(form)(fromForm);
      expect(Form.toEntries(encoded)).toEqual([
        ["_tag", "Move"],
        ["to.x", "3"],
        ["to.y", "4"],
        ["tags[0]", "a"],
        ["tags[1]", "b"],
      ]);

      const key = { tenant: "acme", place: { room: "a&b" } };
      const formKey = yield* Form.encodeKey(Board, key);
      expect(formKey).toBe("tenant=acme&place.room=a%26b");
      const wireKey = yield* Form.decodeKey(Board, formKey);
      expect(wireKey).toBe(yield* Schema.encodeEffect(Board.key)(key));
    }),
  );

  it.effect("an absent boolean field takes the schema's decoding default", () =>
    Effect.gen(function* () {
      const form = Form.codec(TasksMessage);
      const base: ReadonlyArray<readonly [string, string]> = [
        ["_tag", "AddTask"],
        ["id", "c1"],
        ["title", "milk"],
      ];
      const unchecked = yield* Schema.decodeEffect(form)(fields(base));
      const checked = yield* Schema.decodeEffect(form)(fields([...base, ["done", "on"]]));
      expect(unchecked).toEqual({ _tag: "AddTask", id: "c1", title: "milk", done: false });
      expect(checked).toEqual({ _tag: "AddTask", id: "c1", title: "milk", done: true });

      // The JSON wire uses the same encoding: false is absent, true is "on".
      expect(yield* Schema.encodeEffect(Tasks.message)(unchecked)).toBe(
        '{"_tag":"AddTask","id":"c1","title":"milk"}',
      );
      expect(yield* Schema.encodeEffect(Tasks.message)(checked)).toBe(
        '{"_tag":"AddTask","id":"c1","title":"milk","done":"on"}',
      );
    }),
  );

  it.effect("decoding a body missing a generated field fails and mints nothing", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeEffect(Form.codec(AddTask));
      const body = fields([
        ["_tag", "AddTask"],
        ["title", "milk"],
      ]);
      // A seeded Random would make any draw visible: two decodes, one answer.
      const first = yield* Effect.exit(Random.withSeed(decode(body), "one"));
      const second = yield* Effect.exit(Random.withSeed(decode(body), "two"));
      expect(Exit.isFailure(first)).toBe(true);
      expect(Exit.isFailure(second)).toBe(true);
      const issues = yield* Effect.flip(decode(body)).pipe(Effect.map(Form.issuesOf));
      expect(issues.map((issue) => issue.field)).toEqual(["id"]);
    }),
  );

  it.effect("a hostile field name is refused before the message schema is consulted", () =>
    Effect.gen(function* () {
      for (const name of ["__proto__.x", "a.constructor", "prototype", "a..b", "a[x]", "1a"]) {
        const refused = yield* Effect.flip(Form.tree(fields([[name, "1"]])));
        expect(refused._tag).toBe("FormMalformed");
      }
      const conflict = yield* Effect.flip(
        Form.tree(
          fields([
            ["a", "1"],
            ["a.b", "2"],
          ]),
        ),
      );
      expect(conflict._tag).toBe("FormMalformed");
      expect(Object.getPrototypeOf({})).toEqual(Object.prototype);
    }),
  );

  it.effect("a name deeper than the limit or a body with too many fields is refused", () =>
    Effect.gen(function* () {
      const depth = (segments: number) => Array.from({ length: segments }, () => "a").join(".");
      const deepest = yield* Form.tree(fields([[depth(Form.maxDepth), "x"]]));
      expect(Object.keys(deepest)).toEqual(["a"]);

      // A stack walk over 20k segments would overflow; the limit refuses first.
      for (const name of [depth(Form.maxDepth + 1), depth(20_000)]) {
        const refused = yield* Effect.flip(Form.tree(fields([[name, "x"]])));
        expect(refused._tag).toBe("FormMalformed");
      }
      const many = Array.from(
        { length: Form.maxFields + 1 },
        (_, index): readonly [string, string] => [`f${String(index)}`, "x"],
      );
      const crowded = yield* Effect.flip(Form.tree(fields(many)));
      expect(crowded._tag).toBe("FormMalformed");
    }),
  );

  it.effect("a list filled by both [n] and [] is refused, in either order", () =>
    Effect.gen(function* () {
      for (const entries of [
        [
          ["a[1]", "x"],
          ["a[]", "y"],
        ],
        [
          ["a[]", "y"],
          ["a[0]", "x"],
        ],
        [
          ["a[0].b", "x"],
          ["a[]", "y"],
        ],
      ] satisfies ReadonlyArray<ReadonlyArray<readonly [string, string]>>) {
        const refused = yield* Effect.flip(Form.tree(fields(entries)));
        expect(refused._tag).toBe("FormMalformed");
      }
      expect(
        yield* Form.tree(
          fields([
            ["a[1]", "y"],
            ["a[0]", "x"],
            ["b[]", "p"],
            ["b[]", "q"],
          ]),
        ),
      ).toEqual({ a: ["x", "y"], b: ["p", "q"] });
    }),
  );

  it.effect("the return path allows only printable, root-relative, same-origin paths", () =>
    Effect.sync(() => {
      for (const safe of ["/", "/lists/inbox?tab=1#top", "/%2f%2fevil.test", "/a%0ab"]) {
        expect([safe, Form.isReturnPath(safe)]).toEqual([safe, true]);
      }
      for (const hostile of [
        "/\t/evil.test/",
        "/\n/evil.test/",
        "/\r/evil.test/",
        "/\t\\evil.test",
        "/\\evil.test",
        "//evil.test",
        "/a\nb",
        "/a b",
        "/\u0000",
        "/\u007f",
        "/caf\u00e9",
        "https://evil.test/",
        "evil.test",
        "",
      ]) {
        expect([hostile, Form.isReturnPath(hostile)]).toEqual([hostile, false]);
      }
    }),
  );

  it.effect("framework fields are last-write-wins and never reach the message", () =>
    Effect.gen(function* () {
      const posted = fields([
        ["$command", "c1"],
        ["$command", "c2"],
        ["_tag", "AddTask"],
        ["title", ""],
        ["card._cvc", "123"],
      ]);
      expect(Form.last(posted, "$command")).toEqual(Option.some("c2"));
      expect(yield* Form.tree(Form.strip(posted))).toEqual({
        _tag: "AddTask",
        card: { _cvc: "123" },
      });
      expect(Array.from(Form.submitted(posted).keys())).toEqual(["title"]);
      expect(Form.isReturnPath("/lists/inbox")).toBe(true);
      expect(Form.isReturnPath("//evil.test")).toBe(false);
      expect(Form.isReturnPath("/\\evil.test")).toBe(false);
      expect(Form.isReturnPath("https://evil.test")).toBe(false);
      expect(board.tenant).toBe("acme");
    }),
  );
});
