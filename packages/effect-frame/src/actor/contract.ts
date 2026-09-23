import { Schema, SchemaTransformation } from "effect";
import { CommittedRevision, committedRevision } from "./vocabulary.js";

/** A schema whose codecs need no services. Contracts cross the wire alone. */
export type Pure = Schema.Codec<unknown, unknown>;

/**
 * What a client may know about an actor: its name, protocol version, the
 * shape of the key that selects one instance, the snapshot clients observe,
 * and the messages clients may send. Schemas only. This module must stay
 * safe to ship to a browser: it never imports behavior, stores, or hosts.
 */
export interface ActorContract<
  Name extends string,
  Key extends Pure,
  Snapshot extends Pure,
  Message extends Pure,
  Policy extends string = string,
> {
  readonly name: Name;
  /** Bumped when `key`, `snapshot`, or `message` changes incompatibly. */
  readonly version: number;
  /**
   * The policy the host resolves before it opens, reads, or sends to an
   * instance. A name, never a rule: the contract stays browser-safe and the
   * rule stays on the server. The host refuses to build when its table does
   * not hold this name.
   */
  readonly policy: Policy;
  readonly key: Schema.fromJsonString<Key>;
  readonly snapshot: Schema.fromJsonString<Snapshot>;
  readonly message: Schema.fromJsonString<Message>;
  /** The schemas as given, for embedding inside a larger document. */
  readonly raw: { readonly key: Key; readonly snapshot: Snapshot; readonly message: Message };
}

export interface ContractOptions<
  Key extends Pure,
  Snapshot extends Pure,
  Message extends Pure,
  Policy extends string = string,
> {
  readonly version: number;
  /** Selects one instance. Include the tenant so a policy can read it. */
  readonly key: Key;
  /** The public projection of the actor state. Often the state itself. */
  readonly snapshot: Snapshot;
  /** A `Schema.Union` of `Schema.TaggedStruct` members. */
  readonly message: Message;
  /**
   * The name of the policy that guards every instance. Required: an actor
   * with no policy cannot be declared. Allow-all is a name too, written on
   * purpose and registered as `Policy.allowAll`.
   */
  readonly policy: Policy;
}

export type AnyContract = ActorContract<string, Pure, Pure, Pure>;

export type KeyOf<C extends AnyContract> = C["key"]["Type"];
export type SnapshotOf<C extends AnyContract> = C["snapshot"]["Type"];
export type MessageOf<C extends AnyContract> = C["message"]["Type"];

export const contract = <
  const Name extends string,
  Key extends Pure,
  Snapshot extends Pure,
  Message extends Pure,
  const Policy extends string,
>(
  name: Name,
  options: ContractOptions<Key, Snapshot, Message, Policy>,
): ActorContract<Name, Key, Snapshot, Message, Policy> => ({
  name,
  version: options.version,
  policy: options.policy,
  key: Schema.fromJsonString(options.key),
  snapshot: Schema.fromJsonString(options.snapshot),
  message: Schema.fromJsonString(options.message),
  raw: { key: options.key, snapshot: options.snapshot, message: options.message },
});

/**
 * A committed revision as JSON carries it: a plain number. Only a committed
 * revision can be written here; a provisional value has no number to write.
 */
export const CommittedRevisionFromNumber = Schema.Finite.pipe(
  Schema.decodeTo(
    CommittedRevision,
    SchemaTransformation.transform({
      decode: (value: number) => committedRevision(value),
      encode: (revision: CommittedRevision) => revision.value,
    }),
  ),
);

/**
 * The codec for a committed snapshot a server hands a client, so the
 * client's reference can resume from it. One JSON string carries both; the
 * revision stays a number on the wire and decodes to a committed revision.
 */
export type ResumeCodec<C extends AnyContract> = Schema.fromJsonString<
  Schema.Struct<{
    readonly revision: typeof CommittedRevisionFromNumber;
    readonly state: C["raw"]["snapshot"];
  }>
>;

export const resumeCodec = <C extends AnyContract>(definition: C): ResumeCodec<C> => {
  const snapshot: C["raw"]["snapshot"] = definition.raw.snapshot;
  return Schema.fromJsonString(
    Schema.Struct({ revision: CommittedRevisionFromNumber, state: snapshot }),
  );
};

/** Where one actor instance lives on the wire. Every field is a string. */
export interface Address {
  readonly contract: string;
  readonly version: number;
  readonly key: string;
}
