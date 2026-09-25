import { Duration, Effect, Layer, Predicate, Ref, Schedule, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Address } from "../contract.js";
import type { TransportService } from "../transport.js";
import { ActorTransport } from "../transport.js";
import { Unreachable } from "../vocabulary.js";
import {
  AddressBody,
  CallBody,
  CallWireError,
  QueryBody,
  QueryBatchBody,
  ReadWireError,
  SendBody,
  SendWireError,
  WireApplied,
  WireProjection,
  WireQueryError,
  WireQueryBatch,
  WireQueryValue,
  WireReceipt,
  errorEvent,
  eventPrefix,
  paths,
} from "./wire.js";

export interface HttpClientOptions {
  /** For example `https://app.example.com/actors`. No trailing slash. */
  readonly baseUrl: string;
  /**
   * Delay between reconnect attempts of a `changes` stream. It is never
   * entered on `Unauthorized`: a refusal is not a network failure.
   */
  readonly reconnect: Schedule.Schedule<unknown>;
}

/** One `data:` line of the event stream, and whether an `event: error` line named it. */
interface EventLine {
  readonly error: boolean;
  readonly data: string;
}

/**
 * Pairs each `data:` line with the event name before it. The server ends a
 * stream it refuses with `event: error` and one encoded `WireError`; every
 * other `data:` line is a projection.
 */
const readEvents = (
  lines: Stream.Stream<string, Unreachable>,
): Stream.Stream<EventLine, Unreachable> =>
  Stream.mapAccum(
    lines,
    () => false,
    (named, line): readonly [boolean, ReadonlyArray<EventLine>] => {
      if (line === errorEvent) {
        return [true, []];
      }
      if (line.startsWith(eventPrefix)) {
        return [false, [{ error: named, data: line.slice(eventPrefix.length) }]];
      }
      if (line === "") {
        return [false, []];
      }
      return [named, []];
    },
  );

const unreachable = (cause: unknown) => Unreachable.make({ reason: String(cause) });

const decodeUnknownJson = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
  return (text: string) => Effect.orDie(decode(text));
};

const decodeReceipt = decodeUnknownJson(WireReceipt);
const decodeProjection = decodeUnknownJson(WireProjection);
const decodeApplied = decodeUnknownJson(WireApplied);
const decodeQueryValue = decodeUnknownJson(WireQueryValue);
const decodeSendError = decodeUnknownJson(SendWireError);
const decodeCallError = decodeUnknownJson(CallWireError);
const decodeReadError = decodeUnknownJson(ReadWireError);
const decodeQueryError = decodeUnknownJson(WireQueryError);
const decodeQueryBatch = decodeUnknownJson(WireQueryBatch);
const encodeSend = Schema.encodeEffect(Schema.fromJsonString(SendBody));
const encodeCall = Schema.encodeEffect(Schema.fromJsonString(CallBody));
const encodeAddress = Schema.encodeEffect(Schema.fromJsonString(AddressBody));
const encodeQuery = Schema.encodeEffect(Schema.fromJsonString(QueryBody));
const encodeQueryBatch = Schema.encodeEffect(Schema.fromJsonString(QueryBatchBody));

const make = Effect.fn("ActorTransport.http")(function* (options: HttpClientOptions) {
  const client = yield* HttpClient.HttpClient;

  /** One POST. An interrupted request is aborted by the client. */
  const post = <E>(path: string, body: string, decodeError: (text: string) => Effect.Effect<E>) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(`${options.baseUrl}${path}`).pipe(
        HttpClientRequest.bodyText(body, "application/json"),
      );
      const response = yield* Effect.mapError(client.execute(request), unreachable);
      const text = yield* Effect.mapError(response.text, unreachable);
      if (response.status >= 200 && response.status < 300) {
        return text;
      }
      if (response.status >= 500 && response.status !== 503 && response.status !== 504) {
        return yield* unreachable(`${response.status} ${text}`);
      }
      return yield* Effect.flatMap(decodeError(text), (error) => Effect.fail(error));
    });

  const send: TransportService["send"] = (address, commandId, payload, active) =>
    Effect.gen(function* () {
      const body = yield* Effect.orDie(encodeSend({ address, commandId, payload, active }));
      const wire = yield* decodeReceipt(yield* post(paths.send, body, decodeSendError));
      return {
        receipt: { commandId: wire.commandId, admitted: wire.admitted, committed: wire.committed },
        refreshed: wire.refreshed,
      };
    });

  const call: TransportService["call"] = (address, commandId, payload, timeout, active) =>
    Effect.gen(function* () {
      const timeoutMillis = Duration.toMillis(timeout);
      const body = yield* Effect.orDie(
        encodeCall({ address, commandId, payload, timeoutMillis, active }),
      );
      const wire = yield* decodeApplied(yield* post(paths.call, body, decodeCallError));
      return {
        projection: { revision: wire.revision, snapshot: wire.snapshot },
        refreshed: wire.refreshed,
      };
    });

  const query: TransportService["query"] = (key) =>
    Effect.gen(function* () {
      const body = yield* Effect.orDie(encodeQuery({ key }));
      const wire = yield* decodeQueryValue(yield* post(paths.query, body, decodeQueryError));
      return wire.result;
    });

  const queryBatch: TransportService["queryBatch"] = (keys) =>
    Effect.gen(function* () {
      const body = yield* Effect.orDie(encodeQueryBatch({ keys }));
      return yield* decodeQueryBatch(yield* post(paths.queryBatch, body, decodeQueryError));
    });

  const snapshot: TransportService["snapshot"] = (address) =>
    Effect.gen(function* () {
      const body = yield* Effect.orDie(encodeAddress({ address }));
      return yield* decodeProjection(yield* post(paths.snapshot, body, decodeReadError));
    });

  const changesUrl = (address: Address, after: number) => {
    const params = new URLSearchParams({
      contract: address.contract,
      version: String(address.version),
      key: address.key,
      after: String(after),
    });
    return `${options.baseUrl}${paths.changes}?${params.toString()}`;
  };

  /** One connection. Ends when the server closes it; fails when the network does. */
  const connect = (address: Address, after: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const response = yield* Effect.mapError(
          client.execute(HttpClientRequest.get(changesUrl(address, after))),
          unreachable,
        );
        if (response.status < 200 || response.status >= 300) {
          const text = yield* Effect.mapError(response.text, unreachable);
          return Stream.fail(yield* decodeReadError(text));
        }
        // The body stream aborts the request when it ends or is interrupted.
        const lines = response.stream.pipe(
          Stream.mapError(unreachable),
          Stream.decodeText,
          Stream.splitLines,
        );
        return readEvents(lines).pipe(
          Stream.mapEffect((event) => {
            if (event.error) {
              return Effect.flatMap(decodeReadError(event.data), (error) => Effect.fail(error));
            }
            return decodeProjection(event.data);
          }),
          // From the client's view the stream never ends. A server that closes
          // the connection is a disconnect, and the schedule decides the retry.
          Stream.concat(Stream.fail(unreachable("the event stream ended"))),
        );
      }),
    );

  /**
   * Reconnects after a network failure from the last revision it saw, so a
   * dropped connection never loses or repeats a revision. `Unauthorized`
   * fails at once: a revoked principal is refused again on every reconnect,
   * and retrying it only adds load while the server handles a sign-out.
   */
  const changes: TransportService["changes"] = (address, after) =>
    Stream.unwrap(
      Effect.map(Ref.make(after), (last) =>
        Stream.unwrap(Effect.map(Ref.get(last), (from) => connect(address, from))).pipe(
          Stream.tap((projection) => Ref.set(last, projection.revision)),
          // A refusal ends the stream for good; only a network failure is retried.
          Stream.retry(
            Schedule.while(
              options.reconnect,
              (metadata) => !Predicate.isTagged(metadata.input, "Unauthorized"),
            ),
          ),
          Stream.filter((projection) => projection.revision > after),
        ),
      ),
    );

  const transport: TransportService = { send, call, snapshot, query, queryBatch, changes };
  return transport;
});

/**
 * The actor transport over HTTP, through the `HttpClient` in context. A
 * browser or server provides `FetchHttpClient.layer`; a test provides a
 * client whose `fetch` is the host's handler.
 *
 * ```ts
 * import { FetchHttpClient } from "effect/unstable/http";
 *
 * const transport = HttpTransport.layer({
 *   baseUrl: "/actors",
 *   reconnect: HttpTransport.defaultReconnect,
 * }).pipe(Layer.provide(FetchHttpClient.layer));
 * ```
 */
export const layer = (
  options: HttpClientOptions,
): Layer.Layer<ActorTransport, never, HttpClient.HttpClient> =>
  Layer.effect(ActorTransport, make(options));

export const defaultReconnect: Schedule.Schedule<unknown> = Schedule.exponential("100 millis").pipe(
  Schedule.upTo({ times: 10 }),
);
