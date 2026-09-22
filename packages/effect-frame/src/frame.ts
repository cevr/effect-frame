import { Context, Effect, Layer, Match, Option, Schema } from "effect";
import type {
  QueryValue as InspectionQueryValue,
  Record as InspectionRecord,
  Sample,
} from "./inspection.js";
import * as Inspection from "./inspection.js";

// ---------------------------------------------------------------------------
// Public snapshot schema
// ---------------------------------------------------------------------------

/** An opaque identity allocated by one Frame root. */
export const Identity = Schema.String.pipe(Schema.brand("FrameIdentity"));
export type Identity = Schema.Schema.Type<typeof Identity>;

const Primitive = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);

/**
 * A bounded diagnostic value. Values are tagged so an empty object, an
 * unsupported value, and a value cut short by the bounds remain distinct.
 */
export type DiagnosticData =
  | Schema.Schema.Type<typeof Primitive>
  | ReadonlyArray<DiagnosticValue>
  | Readonly<Record<string, DiagnosticValue>>;

export type DiagnosticValue =
  | { readonly _tag: "Value"; readonly value: DiagnosticData }
  | { readonly _tag: "Opaque"; readonly reason: string }
  | { readonly _tag: "Truncated"; readonly reason: string };

export const DiagnosticValue: Schema.Schema<DiagnosticValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.TaggedStruct("Value", {
      value: Schema.Union([
        Primitive,
        Schema.Array(DiagnosticValue),
        Schema.Record(Schema.String, DiagnosticValue),
      ]),
    }),
    Schema.TaggedStruct("Opaque", { reason: Schema.String }),
    Schema.TaggedStruct("Truncated", { reason: Schema.String }),
  ]),
);

const RecordFields = {
  id: Identity,
  ownerId: Identity,
  parentOwnerId: Schema.NullOr(Identity),
};

const Mount = Schema.TaggedStruct("Mount", {
  ...RecordFields,
  phase: Schema.Literals(["entering", "mounted"]),
});

const Actor = Schema.TaggedStruct("Actor", {
  ...RecordFields,
  kind: Schema.Literals(["local", "durable"]),
  revision: Schema.Finite,
});

const QueryValueSchema = Schema.Union([
  Schema.TaggedStruct("Absent", {}),
  Schema.TaggedStruct("Encoded", {
    encoding: Schema.Literal("json"),
    value: Schema.String,
  }),
  Schema.TaggedStruct("Unsupported", { reason: Schema.String }),
]);

const Query = Schema.TaggedStruct("Query", {
  ...RecordFields,
  cacheId: Identity,
  key: Schema.String,
  state: Schema.Literals(["Loading", "Ready", "Failed"]),
  stale: Schema.NullOr(Schema.Boolean),
  ageMs: Schema.Finite,
  value: QueryValueSchema,
  failure: Schema.NullOr(DiagnosticValue),
});

const Route = Schema.TaggedStruct("Route", {
  ...RecordFields,
  routerId: Identity,
  routeInstanceId: Identity,
  routeName: Schema.String,
  phase: Schema.Literals(["entering", "mounted"]),
  params: DiagnosticValue,
  search: DiagnosticValue,
  canonicalRouteName: Schema.String,
  canonicalUrl: Schema.String,
});

const UrlState = Schema.TaggedStruct("UrlState", {
  ...RecordFields,
  routeInstanceId: Identity,
  keys: Schema.Array(Schema.String),
  value: DiagnosticValue,
});

const CommandsUnavailable = Schema.TaggedStruct("Unavailable", {
  reason: Schema.Literal("ClientCommandLifecycleNotImplemented"),
});

export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  root: Schema.Struct({
    id: Identity,
    name: Schema.NullOr(Schema.String),
  }),
  collection: Schema.Literal("sampled"),
  startedAt: Schema.Finite,
  finishedAt: Schema.Finite,
  mounts: Schema.Array(Mount),
  routes: Schema.Array(Route),
  actors: Schema.Array(Actor),
  queries: Schema.Array(Query),
  urlStates: Schema.Array(UrlState),
  commands: CommandsUnavailable,
});
export type Snapshot = Schema.Schema.Type<typeof Snapshot>;

export interface FrameService {
  readonly inspect: Effect.Effect<Snapshot>;
}

export class Service extends Context.Service<Service, FrameService>()(
  "effect-frame/src/frame/Service",
) {}

export const inspect: Effect.Effect<Snapshot, never, Service> = Effect.flatMap(
  Service,
  (frame) => frame.inspect,
);

// ---------------------------------------------------------------------------
// Diagnostic conversion
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6;
const MAX_ENTRIES = 32;
const MAX_NODES = 128;
const MAX_STRING_LENGTH = 512;
const MAX_PROPERTY_NAME_LENGTH = 128;
const MAX_DIAGNOSTIC_COST = 16_384;

interface DiagnosticBudget {
  remainingNodes: number;
  remainingCost: number;
}

const opaque = (reason: string): DiagnosticValue => ({ _tag: "Opaque", reason });
const truncated = (reason: string): DiagnosticValue => ({ _tag: "Truncated", reason });

const spend = (budget: DiagnosticBudget, cost: number): boolean => {
  if (cost > budget.remainingCost) {
    return false;
  }
  budget.remainingCost -= cost;
  return true;
};

const spendNode = (budget: DiagnosticBudget): boolean => {
  if (budget.remainingNodes === 0) {
    return false;
  }
  budget.remainingNodes -= 1;
  return spend(budget, 24);
};

const stringCost = (value: string): number => value.length * 2 + 32;

/**
 * This budget measures the structural cost of the produced diagnostic. It
 * reserves a fixed node cost and a UTF-16 string cost. It bounds the emitted
 * output, but it cannot bound reflection work such as Object.keys or proxy
 * traps, and it does not count final JSON or UTF-8 encoding bytes exactly.
 */

const ownPropertyDescriptor = <Input extends {}>(
  input: Input,
  name: string,
): Option.Option<Option.Option<PropertyDescriptor>> =>
  Option.liftThrowable(() => Option.fromNullishOr(Object.getOwnPropertyDescriptor(input, name)))();

type DiagnosticInput = Schema.Schema.Type<typeof Schema.Unknown>;

const diagnosticPrimitive = (
  input: DiagnosticInput,
  budget: DiagnosticBudget,
): Option.Option<DiagnosticValue> => {
  if (Schema.is(Schema.Null)(input)) {
    if (!spend(budget, 16)) {
      return Option.some(truncated("maximum-size"));
    }
    return Option.some({ _tag: "Value", value: Schema.decodeUnknownSync(Schema.Null)(input) });
  }
  if (Schema.is(Schema.String)(input)) {
    if (input.length > MAX_STRING_LENGTH) {
      return Option.some(truncated("maximum-string-length"));
    }
    if (!spend(budget, stringCost(input))) {
      return Option.some(truncated("maximum-size"));
    }
    return Option.some({ _tag: "Value", value: input });
  }
  if (Schema.is(Schema.Boolean)(input)) {
    if (!spend(budget, 20)) {
      return Option.some(truncated("maximum-size"));
    }
    return Option.some({ _tag: "Value", value: input });
  }
  if (Schema.is(Schema.Finite)(input)) {
    if (!spend(budget, 32)) {
      return Option.some(truncated("maximum-size"));
    }
    return Option.some({ _tag: "Value", value: input });
  }
  return Option.none();
};

const diagnosticArray = (
  input: DiagnosticInput,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: DiagnosticBudget,
): DiagnosticValue => {
  if (!Schema.is(Schema.ObjectKeyword)(input)) {
    return opaque("unsupported-value");
  }
  const readLength = ownPropertyDescriptor(input, "length");
  if (Option.isNone(readLength)) {
    return opaque("unreadable-object");
  }
  const lengthDescriptor = readLength.value;
  if (Option.isNone(lengthDescriptor)) {
    return truncated("maximum-entries");
  }
  if ("get" in lengthDescriptor.value || "set" in lengthDescriptor.value) {
    return opaque("accessor");
  }
  const length = lengthDescriptor.value.value;
  if (!Schema.is(Schema.Finite)(length) || !Number.isSafeInteger(length) || length > MAX_ENTRIES) {
    return truncated("maximum-entries");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(input);
  const values: Array<DiagnosticValue> = [];
  for (let index = 0; index < length; index += 1) {
    if (!spend(budget, 20)) {
      return truncated("maximum-size");
    }
    const readDescriptor = ownPropertyDescriptor(input, String(index));
    if (Option.isNone(readDescriptor)) {
      return opaque("unreadable-object");
    }
    const descriptor = readDescriptor.value;
    if (Option.isNone(descriptor)) {
      values.push(opaque("array-hole"));
    } else if ("get" in descriptor.value || "set" in descriptor.value) {
      values.push(opaque("accessor"));
    } else {
      values.push(diagnostic(descriptor.value.value, depth + 1, nextAncestors, budget));
    }
  }
  return { _tag: "Value", value: values };
};

const diagnosticRecord = (
  input: DiagnosticInput,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: DiagnosticBudget,
): DiagnosticValue => {
  if (!Schema.is(Schema.ObjectKeyword)(input)) {
    return opaque("unsupported-value");
  }
  const readableKeys = Option.liftThrowable(() => Object.keys(input))();
  if (Option.isNone(readableKeys)) {
    return opaque("unreadable-object");
  }
  const keys = readableKeys.value;
  if (keys.length > MAX_ENTRIES) {
    return truncated("maximum-entries");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(input);
  const value: Record<string, DiagnosticValue> = {};
  for (const key of keys) {
    if (key.length > MAX_PROPERTY_NAME_LENGTH) {
      return truncated("maximum-property-name-length");
    }
    if (!spend(budget, stringCost(key))) {
      return truncated("maximum-size");
    }
    const readDescriptor = ownPropertyDescriptor(input, key);
    if (Option.isNone(readDescriptor)) {
      return opaque("unreadable-object");
    }
    const descriptor = readDescriptor.value;
    if (Option.isNone(descriptor)) {
      continue;
    }
    if ("get" in descriptor.value || "set" in descriptor.value) {
      return opaque("accessor");
    }
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      value: diagnostic(descriptor.value.value, depth + 1, nextAncestors, budget),
      writable: true,
    });
  }
  return { _tag: "Value", value };
};

const diagnosticObject = (
  input: DiagnosticInput,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: DiagnosticBudget,
): DiagnosticValue => {
  if (!Schema.is(Schema.ObjectKeyword)(input)) {
    return opaque("unsupported-value");
  }
  const readable = Option.liftThrowable(() => ({
    array: Array.isArray(input),
    prototype: Object.getPrototypeOf(input),
  }))();
  if (Option.isNone(readable)) {
    return opaque("unreadable-object");
  }
  const { array, prototype } = readable.value;
  if (prototype !== Object.prototype && Option.isSome(Option.fromNullishOr(prototype)) && !array) {
    return opaque("unsupported-object");
  }
  if (array) {
    return diagnosticArray(input, depth, ancestors, budget);
  }
  return diagnosticRecord(input, depth, ancestors, budget);
};

const diagnostic = (
  input: DiagnosticInput,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: DiagnosticBudget,
): DiagnosticValue => {
  if (!spendNode(budget)) {
    return truncated("maximum-size");
  }
  const primitive = diagnosticPrimitive(input, budget);
  if (Option.isSome(primitive)) {
    return primitive.value;
  }
  if (!Schema.is(Schema.ObjectKeyword)(input)) {
    return opaque("unsupported-value");
  }
  if (depth >= MAX_DEPTH) {
    return truncated("maximum-depth");
  }
  if (ancestors.has(input)) {
    return opaque("cycle");
  }
  return diagnosticObject(input, depth, ancestors, budget);
};

const toDiagnostic = (input: DiagnosticInput): DiagnosticValue =>
  diagnostic(input, 0, new Set(), {
    remainingNodes: MAX_NODES,
    remainingCost: MAX_DIAGNOSTIC_COST,
  });

const identity = (value: string): Identity => Schema.decodeUnknownSync(Identity)(value);

const base = (record: InspectionRecord) => ({
  id: identity(record.id),
  ownerId: identity(record.ownerId),
  parentOwnerId: Option.getOrNull(Option.map(record.parentOwnerId, identity)),
});

export type QueryValue = Schema.Schema.Type<typeof QueryValueSchema>;

const toQueryValue = (value: InspectionQueryValue): QueryValue =>
  Match.type<InspectionQueryValue>().pipe(
    Match.withReturnType<QueryValue>(),
    Match.tagsExhaustive({
      Absent: () => ({ _tag: "Absent" }),
      Encoded: (encoded) => ({ _tag: "Encoded", encoding: "json", value: encoded.value }),
      Unsupported: (unsupported) => ({ _tag: "Unsupported", reason: unsupported.reason }),
    }),
  )(value);

const toSnapshot = (sample: Sample): Snapshot => {
  const mounts: Array<Snapshot["mounts"][number]> = [];
  const routes: Array<Snapshot["routes"][number]> = [];
  const actors: Array<Snapshot["actors"][number]> = [];
  const queries: Array<Snapshot["queries"][number]> = [];
  const urlStates: Array<Snapshot["urlStates"][number]> = [];

  for (const record of sample.records) {
    switch (record._tag) {
      case "Mount":
        mounts.push({ ...base(record), _tag: "Mount", phase: record.phase });
        break;
      case "Route":
        routes.push({
          ...base(record),
          _tag: "Route",
          routerId: identity(record.routerId),
          routeInstanceId: identity(record.routeInstanceId),
          routeName: record.routeName,
          phase: record.phase,
          params: toDiagnostic(record.params),
          search: toDiagnostic(record.search),
          canonicalRouteName: record.canonicalRouteName,
          canonicalUrl: record.canonicalUrl,
        });
        break;
      case "Actor":
        actors.push({
          ...base(record),
          _tag: "Actor",
          kind: record.kind,
          revision: record.revision,
        });
        break;
      case "Query":
        queries.push({
          ...base(record),
          _tag: "Query",
          cacheId: identity(record.cacheId),
          key: record.key,
          state: record.state,
          stale: Option.getOrNull(record.stale),
          ageMs: record.ageMs,
          value: toQueryValue(record.value),
          failure: Option.getOrNull(Option.map(record.failure, toDiagnostic)),
        });
        break;
      case "UrlState":
        urlStates.push({
          ...base(record),
          _tag: "UrlState",
          routeInstanceId: identity(record.routeInstanceId),
          keys: [...record.keys],
          value: toDiagnostic(record.value),
        });
        break;
    }
  }

  return {
    version: 1,
    root: { id: identity(sample.rootId), name: Option.getOrNull(sample.rootName) },
    collection: "sampled",
    startedAt: sample.startedAt,
    finishedAt: sample.finishedAt,
    mounts,
    routes,
    actors,
    queries,
    urlStates,
    commands: {
      _tag: "Unavailable",
      reason: "ClientCommandLifecycleNotImplemented",
    },
  } satisfies Snapshot;
};

export interface LayerOptions {
  readonly name?: string;
}

/** Build one inspection registry and Frame service for one application root. */
export const layer = (options: LayerOptions = {}): Layer.Layer<Service | Inspection.Registry> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const registry = yield* Inspection.makeRegistry(Option.fromNullishOr(options.name));
      const frame: FrameService = {
        inspect: Effect.map(registry.sample, toSnapshot),
      };
      return Context.make(Inspection.Registry, registry).pipe(Context.add(Service, frame));
    }),
  );
