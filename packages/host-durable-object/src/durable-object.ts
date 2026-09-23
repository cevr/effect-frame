import { Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { DurableHostConfig } from "effect-frame/actor";
import type { HostedActor, Reply } from "./frame-actor.js";
import { emptyBody, handle, host, readBody, toCommand } from "./frame-actor.js";
import type { DurableStorage } from "./storage.js";

/**
 * What a Durable Object hands its class. celld and Cloudflare both supply a
 * wider object; the host uses only the storage.
 */
export interface DurableObjectContext {
  readonly storage: DurableStorage;
}

/** The host's tuning. A durable store reads from disk, so it polls faster. */
const hostLayer = Layer.succeed(
  DurableHostConfig,
  DurableHostConfig.of({ pollInterval: "20 millis" }),
);

/**
 * Waits until the mailbox is empty. The actor drains it on its own; this only
 * holds the alarm open so the runtime does not evict the object mid-drain.
 * The bound keeps one alarm well inside the transaction limit.
 */
const drain = Effect.fn("FrameActor.drain")(function* (actor: HostedActor) {
  const step = Effect.fn("FrameActor.drain.step")(function* () {
    const pending = yield* actor.pending;
    if (pending.length === 0) {
      return true;
    }
    yield* Effect.sleep("20 millis");
    return false;
  });
  yield* Effect.repeat(step(), { until: (empty) => empty, times: 1000 });
});

/** Parses one request and runs it. The source is whatever the body decoded to. */
const serve = Effect.fn("FrameActor.serve")(function* (
  actor: HostedActor,
  path: string,
  source: unknown,
) {
  const body = yield* Effect.orElseSucceed(readBody(source), () => emptyBody);
  return yield* handle(actor, toCommand(path, body));
});

const failureReply = (cause: unknown): Reply => ({
  status: 500,
  body: { error: "HostFailure", detail: String(cause) },
});

/**
 * Hosts one durable actor inside one Durable Object.
 *
 * The object owns a scope. The first request that needs the actor opens it;
 * every later request reuses it. A restart loses the scope, not the state:
 * the store reloads the committed revision and drains the pending commands.
 * `alarm()` exists for exactly that case, so a command admitted before a
 * crash runs with no client request.
 */
export class FrameActor {
  readonly #context: DurableObjectContext;
  readonly #scope: Scope.Closeable;
  readonly #runtime: ManagedRuntime.ManagedRuntime<never, never>;
  #actor: Option.Option<Promise<HostedActor>> = Option.none();

  constructor(context: DurableObjectContext, _env: unknown) {
    this.#context = context;
    this.#scope = Effect.runSync(Scope.make());
    this.#runtime = ManagedRuntime.make(hostLayer);
  }

  /**
   * The running actor. One object builds one. A concurrent request awaits the
   * same promise, so two fetches never spawn two actors over one mailbox.
   */
  #ensureRunning(): Promise<HostedActor> {
    return Option.match(this.#actor, {
      onSome: (running) => running,
      onNone: () => {
        const starting = this.#runtime.runPromise(
          Scope.provide(host(this.#context.storage), this.#scope),
        );
        this.#actor = Option.some(starting);
        return starting;
      },
    });
  }

  /**
   * The wake the admission transaction armed. It starts the actor, which
   * drains every pending command in admission order. It returns once the
   * mailbox is empty, so a retried alarm cannot leave a command behind.
   */
  async alarm(): Promise<void> {
    const actor = await this.#ensureRunning();
    await this.#runtime.runPromise(drain(actor));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const source: unknown = await request.json().catch(() => ({}));
    const actor = await this.#ensureRunning();
    const outcome = await this.#runtime.runPromiseExit(serve(actor, path, source));
    const reply = Exit.match(outcome, {
      onSuccess: (value: Reply) => value,
      onFailure: failureReply,
    });
    return Response.json(reply.body, { status: reply.status });
  }
}
