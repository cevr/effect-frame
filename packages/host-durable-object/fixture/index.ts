import { FrameActor } from "./durable-object.js";

/**
 * The crash-proof fixture worker. It routes `/actor/:key/...` to one Durable
 * Object per key, so one run can test several independent mailboxes.
 *
 * This is a proof fixture, not a library entry point. Its `Add` message
 * carries a `delayMs` barrier, which holds the turn open so a kill can land
 * between the accepted response and the commit. A production worker would
 * not expose that.
 */

interface ActorNamespace {
  readonly idFromName: (name: string) => unknown;
  readonly get: (id: unknown) => { readonly fetch: (request: Request) => Promise<Response> };
}

interface Env {
  readonly ACTOR: ActorNamespace;
}

const notFound = (path: string): Response =>
  Response.json({ error: "NotFound", path }, { status: 404 });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length < 2 || parts[0] !== "actor") {
      return notFound(url.pathname);
    }
    const key = parts[1];
    if (key === undefined) {
      return notFound(url.pathname);
    }
    const rest = `/${parts.slice(2).join("/")}`;
    const inner = new Request(new URL(rest + url.search, url.origin), request);
    return await env.ACTOR.get(env.ACTOR.idFromName(key)).fetch(inner);
  },
};

export { FrameActor };
