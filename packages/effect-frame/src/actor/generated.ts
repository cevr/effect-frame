import { Effect, Option, Random, Schema, SchemaAST } from "effect";
import { freshCommandId, mintedFor } from "./command-id.js";
import type { AnyContract, SnapshotOf } from "./contract.js";
import type { RemoteCommandRef } from "./ref.js";
import type { CommandId, IdentifiedCommandHandle } from "./vocabulary.js";

/**
 * A value a message needs that no one types. The render that offers
 * the command chooses it, from the command's own identity or beside it, so
 * every submission of one rendered form carries the same value and the
 * command applies once. Nothing generates it when a submission arrives:
 * a decoder that invented a value would put a new payload under an old
 * command id.
 */
export type Generation =
  | { readonly _tag: "FromCommandId" }
  | { readonly _tag: "FreshId"; readonly width: number };

/** The annotation key the mark travels under, on the field's schema. */
export const annotation = "effect-frame/Generated";

/**
 * The type-level mark. It exists in types only: `Input` reads it to drop
 * the field from what an author constructs, and the brand on `Encoded`
 * makes a hand-written default a type error.
 */
export declare const GeneratedTypeId: unique symbol;

/** No code can produce this brand, so no default can be written for it. */
export interface Minted {
  readonly [GeneratedTypeId]: "Minted";
}

/**
 * A field schema marked as generated. The decoded type is unchanged, so a
 * behavior reads `add.id` as a plain string. The encoded side carries a
 * brand that no literal satisfies, which is what refuses
 * `Schema.withDecodingDefault` over it.
 */
export type Generated<S extends Schema.Top> = S & {
  readonly [GeneratedTypeId]: Generation["_tag"];
  readonly Encoded: S["Encoded"] & Minted;
};

/**
 * What a generated field may wrap: a required string codec. A field that
 * already carries a decoding default is optional on its encoded side, so
 * it is refused here too. A generated field is never optional.
 */
export type Mintable = Schema.Codec<string, string> & {
  readonly "~type.optionality": "required";
  readonly "~encoded.optionality": "required";
};

function mark<S extends Mintable>(schema: S, generation: Generation): Generated<S>;
function mark(schema: Schema.Top, generation: Generation): Schema.Top {
  return schema.annotate({ [annotation]: generation });
}

/** The default. One command creates one entity, and its id is the command's id. */
export const fromCommandId = <S extends Mintable>(schema: S): Generated<S> =>
  mark(schema, { _tag: "FromCommandId" });

/**
 * For a field one command id cannot serve: several entities per command.
 * The render draws it from `Random`, beside the command id, once per render.
 */
export const freshId = <S extends Mintable>(schema: S, width = 16): Generated<S> =>
  mark(schema, { _tag: "FreshId", width });

// ---------------------------------------------------------------------------
// Reading the mark
// ---------------------------------------------------------------------------

const readGeneration = SchemaAST.resolveAt<Generation>(annotation);

/** The generation a field's schema carries, if it is marked. */
export const generationOf = (ast: SchemaAST.AST): Option.Option<Generation> =>
  Option.fromNullishOr(readGeneration(ast));

/** One struct member of a message: its tag and its generated fields in order. */
export interface Member {
  readonly tag: string;
  readonly generated: ReadonlyArray<readonly [name: string, generation: Generation]>;
}

const tagOf = (objects: SchemaAST.Objects): Option.Option<string> =>
  Option.flatMap(
    Option.fromNullishOr(objects.propertySignatures.find((property) => property.name === "_tag")),
    (property) => {
      if (SchemaAST.isLiteral(property.type) && Schema.is(Schema.String)(property.type.literal)) {
        return Option.some(property.type.literal);
      }
      return Option.none();
    },
  );

const memberOf = (objects: SchemaAST.Objects): Option.Option<Member> =>
  Option.map(tagOf(objects), (tag) => ({
    tag,
    generated: objects.propertySignatures.flatMap((property) =>
      Option.match(generationOf(property.type), {
        onNone: () => [],
        onSome: (generation): Array<readonly [string, Generation]> => [
          [String(property.name), generation],
        ],
      }),
    ),
  }));

/**
 * The tagged members of a message schema: a `TaggedStruct`, or a union of
 * them. A member with no literal `_tag` is not a form member and is left out.
 */
export const membersOf = (ast: SchemaAST.AST): ReadonlyArray<Member> => {
  if (SchemaAST.isUnion(ast)) {
    return ast.types.flatMap(membersOf);
  }
  if (SchemaAST.isObjects(ast)) {
    return Option.match(memberOf(ast), { onNone: () => [], onSome: (member) => [member] });
  }
  return [];
};

/** The member a tag names, if the message has it. */
export const memberNamed = (ast: SchemaAST.AST, tag: string): Option.Option<Member> =>
  Option.fromNullishOr(membersOf(ast).find((member) => member.tag === tag));

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `width` characters drawn from `Random`, so a test may seed it. */
export const drawFresh = (width: number): Effect.Effect<string> =>
  Effect.map(
    Effect.forEach(Array.from({ length: width }), () =>
      Random.nextIntBetween(0, alphabet.length - 1),
    ),
    (indexes) => indexes.map((index) => alphabet.charAt(index)).join(""),
  );

/** The value one generation mints, given the command id the render chose. */
export const mint = (generation: Generation, commandId: CommandId): Effect.Effect<string> => {
  if (generation._tag === "FromCommandId") {
    return Effect.succeed(commandId);
  }
  return drawFresh(generation.width);
};

/** Every generated value of one member, minted together. */
export const mintAll = (
  member: Member,
  commandId: CommandId,
): Effect.Effect<ReadonlyArray<readonly [name: string, value: string]>> =>
  Effect.forEach(member.generated, ([name, generation]) =>
    Effect.map(mint(generation, commandId), (value): readonly [string, string] => [name, value]),
  );

// ---------------------------------------------------------------------------
// The input an author constructs
// ---------------------------------------------------------------------------

type GeneratedKeys<Fields> = {
  [K in keyof Fields]: Fields[K] extends { readonly [GeneratedTypeId]: unknown } ? K : never;
}[keyof Fields];

type MemberInput<M> = M extends { readonly fields: infer Fields; readonly Type: infer T }
  ? { readonly [K in keyof T as K extends GeneratedKeys<Fields> ? never : K]: T[K] }
  : never;

/**
 * The message an author constructs: every generated field omitted, since
 * supplying one by hand is the mistake the mark exists to prevent.
 * `Schema.Schema.Type` keeps the field required.
 */
export type Input<S> = S extends { readonly members: ReadonlyArray<infer M> }
  ? M extends unknown
    ? MemberInput<M>
    : never
  : MemberInput<S>;

const TaggedInput = Schema.Struct({ _tag: Schema.String });
const readTag = Schema.decodeUnknownEffect(TaggedInput);

/**
 * Send a message whose generated fields the send supplies (the
 * scripted case). The send mints the command id, derives every generated
 * value from it or beside it, and sends both together, so the author never
 * writes the id a note is created under. The contract is the reference's
 * own.
 *
 * @example
 * ```ts
 * const handle = yield* Generated.send(notes, { _tag: "Add", text: "hello" });
 * ```
 */
export const send = <C extends AnyContract>(
  ref: RemoteCommandRef<C>,
  input: Input<C["raw"]["message"]>,
): Effect.Effect<IdentifiedCommandHandle<SnapshotOf<C>, "remote">> =>
  Effect.gen(function* () {
    const contract = ref.contract;
    const tagged = yield* Effect.orDie(readTag(input));
    const member = yield* Option.match(memberNamed(contract.raw.message.ast, tagged._tag), {
      onNone: () => Effect.die(`${contract.name} has no message ${tagged._tag}`),
      onSome: Effect.succeed,
    });
    const commandId = yield* freshCommandId;
    const minted = yield* mintAll(member, commandId);
    const message = yield* Effect.orDie(
      Schema.decodeUnknownEffect(Schema.toType(contract.message))(
        Object.assign({}, input, Object.fromEntries(minted)),
      ),
    );
    // Minted here for this send alone: as fresh as one the reference mints.
    return yield* ref.send(message, mintedFor(commandId));
  });
