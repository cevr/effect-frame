import { Option } from "effect";

/**
 * Routes the generic actor wire from a Worker to one Durable Object per
 * actor address.
 *
 * A client's `HttpTransport` base URL names the address:
 * `/actors/:contract/:version/:key`, where the key segment is the JSON-encoded
 * key the address carries, percent-escaped for the path. The transport then
 * appends a generic verb (`send`, `call`, `snapshot`, `changes`). The router
 * sends the request to the object named `contract@version/key` and rewrites
 * its path to the bare verb, so the object serves exactly the wire the
 * transport speaks.
 */

/** The part of a Durable Object stub the router uses. */
export interface DurableObjectStub {
  readonly fetch: (request: Request) => Promise<Response>;
}

/**
 * The part of a Durable Object namespace binding the router uses. Cloudflare
 * and celld both supply a wider object. The id is opaque to the router.
 */
export interface DurableObjectNamespace<Id> {
  readonly idFromName: (name: string) => Id;
  readonly get: (id: Id) => DurableObjectStub;
}

/** The generic wire verbs the router forwards. */
const verbs: ReadonlySet<string> = new Set(["send", "call", "snapshot", "changes"]);

/** One parsed `/actors/...` request: the object it names and the verb. */
interface Target {
  readonly objectName: string;
  readonly verb: string;
}

/** A malformed escape is a request this router does not serve. */
const decodeSegment = Option.liftThrowable(decodeURIComponent);

/** Reads `/actors/:contract/:version/:key/:verb`. Anything else is absent. */
const targetOf = (pathname: string): Option.Option<Target> => {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 5 || parts[0] !== "actors") {
    return Option.none();
  }
  const [, contract, version, key, verb] = parts;
  return Option.flatMap(
    Option.all({
      contract: Option.fromNullishOr(contract),
      version: Option.fromNullishOr(version),
      key: Option.flatMap(Option.fromNullishOr(key), decodeSegment),
      verb: Option.filter(Option.fromNullishOr(verb), (found) => verbs.has(found)),
    }),
    (found) =>
      Option.some({
        objectName: `${found.contract}@${found.version}/${found.key}`,
        verb: found.verb,
      }),
  );
};

const notFound = (pathname: string): Response =>
  Response.json({ error: "NotFound", path: pathname }, { status: 404 });

/**
 * A Worker `fetch` handler that forwards the generic actor wire to the object
 * that holds the address. One address names one object, so one object holds
 * one actor instance and its mailbox. A path the wire does not use is a 404.
 */
export const route =
  <Id>(namespace: DurableObjectNamespace<Id>) =>
  (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    return Option.match(targetOf(url.pathname), {
      onNone: () => Promise.resolve(notFound(url.pathname)),
      onSome: (target) =>
        namespace
          .get(namespace.idFromName(target.objectName))
          .fetch(new Request(new URL(`/${target.verb}${url.search}`, url.origin), request)),
    });
  };
