/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noTernary, effect/noNodeBuiltinImport, effect/noConditionalEmptyObjectSpread, effect/noThrowStatement, effect/noNewError, effect/noTryCatch, no-await-in-loop -- this proof drives a real WebKit page, a real loopback gateway, and CLI processes. */
/**
 * Live inspection transport proof, items 1-5 of the scope draft. Every test
 * uses a real headless WebKit page running the production-shaped fixture
 * root, a real loopback gateway, real WebSockets, and the CLI-shaped reader.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { resolve } from "node:path";
import type { Protocol } from "effect-frame/inspection";
import { TOKEN_ENV } from "../src/reader.js";
import * as H from "./harness.js";

type Snapshot = Protocol.InspectResponse["snapshot"];

const devBundle = H.bundle("main.dev.tsx");
const prodBundle = H.bundle("main.tsx");

interface Rig {
  readonly page: H.PageServer;
  readonly gateway: H.RunningGateway;
  readonly views: Array<Bun.WebView>;
  readonly open: (name: string, path?: string) => Promise<Bun.WebView>;
  readonly dispose: () => Promise<void>;
}

const rig = async (options: { readonly maxSnapshotBytes?: number } = {}): Promise<Rig> => {
  const page = H.servePage((await devBundle).text);
  const gateway = await H.startGateway({
    allowedOrigin: page.origin,
    ...(options.maxSnapshotBytes === undefined
      ? {}
      : { maxSnapshotBytes: options.maxSnapshotBytes }),
  });
  const views: Array<Bun.WebView> = [];
  return {
    page,
    gateway,
    views,
    open: async (name, path = "/books/7") => {
      const view = await H.openView(
        page.url(path, {
          name,
          gateway: { url: gateway.gateway.attachUrl, token: gateway.attachToken },
        }),
      );
      views.push(view);
      await H.waitFor(view, "window.__fixture && window.__fixture.mountedAt > 0", `${name} mount`);
      await H.waitFor(view, "document.querySelector('#loading')", `${name} held query`);
      return view;
    },
    dispose: async () => {
      for (const view of views) view.close();
      await gateway.close();
      page.stop();
    },
  };
};

const url = (r: Rig) => r.gateway.gateway.url;

const roots = async (r: Rig): Promise<Protocol.RootsResponse> =>
  (await H.cliJson<Protocol.RootsResponse>(["roots", "--url", url(r)], r.gateway.readToken)).body;

const inspect = (r: Rig, root: string, extra: ReadonlyArray<string> = []) =>
  H.cliJson<Protocol.InspectResponse | Protocol.ErrorResponse>(
    ["inspect", "--url", url(r), "--root", root, ...extra],
    r.gateway.readToken,
  );

const direct = async (view: Bun.WebView): Promise<Snapshot> =>
  JSON.parse(await view.evaluate<string>("window.__fixture.inspect()"));

const rootIdOf = async (view: Bun.WebView): Promise<Snapshot["root"]["id"]> =>
  (await direct(view)).root.id;

const waitAttached = (r: Rig, count: number) =>
  H.waitUntil(async () => (await H.stats(r.gateway)).roots === count, `${count} attached roots`);

const inspection = (
  body: Protocol.InspectResponse | Protocol.ErrorResponse,
): Protocol.InspectResponse => {
  if (body._tag !== "Inspection")
    throw new Error(`expected Inspection, got ${JSON.stringify(body)}`);
  return body;
};

const failure = (
  body: Protocol.InspectResponse | Protocol.ErrorResponse,
): Protocol.ErrorResponse["error"] => {
  if (body._tag !== "Error") throw new Error(`expected Error, got ${body._tag}`);
  return body.error;
};

/**
 * Hold the page's only thread; frames queue behind it. WebView evaluation
 * settles only when the page is idle again, so the caller does not await it
 * until the busy period is over.
 */
const busy = async (
  view: Bun.WebView,
  millis: number,
): Promise<{ readonly done: Promise<unknown> }> => {
  const done = view.evaluate(`setTimeout(() => window.__fixture.busy(${millis}), 0), true`).then(
    () => undefined,
    () => undefined,
  );
  await Bun.sleep(50);
  return { done };
};

const recordIds = (snapshot: Snapshot) => ({
  root: snapshot.root,
  mounts: snapshot.mounts.map((record) => [record.id, record.ownerId, record.phase]),
  routes: snapshot.routes.map((record) => [record.id, record.routeName, record.canonicalUrl]),
  actors: snapshot.actors.map((record) => [record.id, record.kind, record.revision]),
  queries: snapshot.queries.map((record) => [record.id, record.cacheId, record.key, record.state]),
});

describe.skipIf(!H.hasBrowser)("live Frame inspection over a browser-originated socket", () => {
  it("1. reads a held QueryTest query from the same browser root as direct inspection", async () => {
    const r = await rig();
    try {
      const view = await r.open("held");
      await waitAttached(r, 1);
      const rootId = await rootIdOf(view);

      const before = await direct(view);
      await Bun.sleep(40);
      const reply = await inspect(r, rootId);
      await Bun.sleep(40);
      const after = await direct(view);

      expect(reply.result.exitCode).toBe(0);
      const read = inspection(reply.body);
      const snapshot = read.snapshot;
      expect(read.root.id).toBe(rootId);
      expect(read.root.name).toBe("held");
      expect(recordIds(snapshot)).toEqual(recordIds(before));
      expect(recordIds(snapshot)).toEqual(recordIds(after));
      expect(snapshot.mounts.map((mount) => mount.phase)).toEqual(["mounted"]);
      expect(snapshot.routes.map((route) => route.routeName)).toEqual(["book"]);
      expect(snapshot.actors.map((actor) => actor.kind)).toEqual(["local"]);
      expect(snapshot.queries).toHaveLength(1);
      const [query] = snapshot.queries;
      expect(query?.state).toBe("Loading");
      expect(query?.key).toContain("InspectionGatewayHeld");
      expect(query?.value).toEqual({ _tag: "Absent" });
      // The same live entry, sampled between two direct reads.
      expect(query?.ageMs).toBeGreaterThan(before.queries[0]?.ageMs ?? Infinity);
      expect(query?.ageMs).toBeLessThan(after.queries[0]?.ageMs ?? -Infinity);
      // The fixture sends no commands: the owner is inspectable and empty.
      expect(snapshot.commands).toEqual({ _tag: "Available", records: [] });
      // Reading did not start, settle, or restart the resolver.
      expect(await view.evaluate<unknown>("window.__fixture.resolverStarts")).toBe(1);
      expect(await view.evaluate<unknown>("window.__fixture.resolverFinished")).toBe(0);
      expect(await view.evaluate<unknown>("Boolean(document.querySelector('#loading'))")).toBe(
        true,
      );

      // Releasing the real resolver is visible to the next fresh sample.
      await view.evaluate<unknown>("window.__fixture.release(), true");
      await H.waitFor(view, "document.querySelector('#result')", "query ready");
      const ready = inspection((await inspect(r, rootId)).body).snapshot.queries[0];
      expect(ready?.state).toBe("Ready");
      expect(ready?.value).toEqual({ _tag: "Encoded", encoding: "json", value: '"book 7"' });
      expect((await H.stats(r.gateway)).pendingReads).toBe(0);
    } finally {
      await r.dispose();
    }
  }, 30_000);

  it("2. keeps two roots distinct and rejects ambiguous and stale selectors", async () => {
    const r = await rig();
    try {
      const left = await r.open("left", "/books/1");
      const right = await r.open("right", "/books/2");
      await waitAttached(r, 2);
      const leftId = await rootIdOf(left);
      const rightId = await rootIdOf(right);
      expect(leftId).not.toBe(rightId);

      const listed = await roots(r);
      expect(listed.roots.map((root) => root.id).toSorted()).toEqual([leftId, rightId].toSorted());

      const leftRead = inspection((await inspect(r, leftId)).body);
      expect(leftRead.snapshot.root.id).toBe(leftId);
      expect(leftRead.snapshot.queries[0]?.key).toContain('"1"');
      const rightByName = inspection((await inspect(r, "right")).body);
      expect(rightByName.snapshot.root.id).toBe(rightId);
      expect(rightByName.snapshot.queries[0]?.key).toContain('"2"');

      // A prefix both roots share never picks one of them.
      const ambiguous = await inspect(r, "frame-root-");
      expect(ambiguous.result.exitCode).toBe(1);
      const ambiguousError = failure(ambiguous.body);
      expect(ambiguousError._tag).toBe("AmbiguousRoot");
      if (ambiguousError._tag === "AmbiguousRoot") {
        expect(ambiguousError.candidates.map((root) => root.id).toSorted()).toEqual(
          [leftId, rightId].toSorted(),
        );
      }

      // A selector for a root that closed is stale, not rerouted.
      right.close();
      await waitAttached(r, 1);
      const stale = await inspect(r, rightId);
      expect(stale.result.exitCode).toBe(1);
      expect(failure(stale.body)).toEqual({ _tag: "RootNotFound", selector: rightId, attached: 1 });
      const staleName = await inspect(r, "right");
      expect(failure(staleName.body)._tag).toBe("RootNotFound");
      // The remaining root still answers only for itself.
      expect(inspection((await inspect(r, "frame-root-")).body).snapshot.root.id).toBe(leftId);
    } finally {
      await r.dispose();
    }
  }, 30_000);

  it("3. a reader deadline or disconnect cancels only its own collection", async () => {
    const r = await rig();
    try {
      const view = await r.open("cancel");
      await waitAttached(r, 1);
      const rootId = await rootIdOf(view);

      const blocked = await busy(view, 3_000);
      const killed = Bun.spawn(
        [
          "bun",
          "--conditions=source",
          resolve(import.meta.dir, "../src/bin.ts"),
          "inspect",
          "--url",
          url(r),
          "--root",
          rootId,
          "--deadline",
          "8000",
          "--json",
        ],
        {
          env: { ...Bun.env, [TOKEN_ENV]: r.gateway.readToken },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await H.waitUntil(
        async () => (await H.stats(r.gateway)).pendingReads === 1,
        "process read pending",
      );
      const started = performance.now();
      const short = inspect(r, rootId, ["--deadline", "300"]);
      const patient = inspect(r, rootId, ["--deadline", "8000"]);
      await H.waitUntil(
        async () => (await H.stats(r.gateway)).pendingReads === 3,
        "three pending reads",
      );
      killed.kill("SIGINT");
      const killedExit = await killed.exited;

      const shortReply = await short;
      const shortMillis = performance.now() - started;
      expect(shortReply.result.exitCode).toBe(1);
      expect(failure(shortReply.body)).toEqual({
        _tag: "DeadlineExceeded",
        root: rootId,
        deadlineMillis: 300,
      });
      expect(shortMillis).toBeLessThan(1_400);
      expect(killedExit).toBe(130);
      expect(await new Response(killed.stderr).text()).toContain("interrupted");
      // Even when interrupted, --json leaves exactly one versioned document.
      expect(await new Response(killed.stdout).text()).toBe(
        `${JSON.stringify({ _tag: "Error", version: 1, error: { _tag: "Interrupted", signal: "SIGINT" } })}\n`,
      );

      await blocked.done;
      const patientReply = await patient;
      expect(patientReply.result.exitCode).toBe(0);
      const snapshot = inspection(patientReply.body).snapshot;
      expect(snapshot.queries[0]?.state).toBe("Loading");

      const after = await H.stats(r.gateway);
      expect(after.pendingReads).toBe(0);
      expect(after.readsInterrupted).toBe(1);
      expect(after.roots).toBe(1);
      // The application kept running and kept its held resolver.
      expect(await view.evaluate<unknown>("window.__fixture.closed")).toBe(false);
      expect(await view.evaluate<unknown>("window.__fixture.resolverStarts")).toBe(1);
      expect(await view.evaluate<unknown>("window.__fixture.resolverFinished")).toBe(0);
      expect(await view.evaluate<unknown>("Boolean(document.querySelector('#loading'))")).toBe(
        true,
      );
      expect(inspection((await inspect(r, rootId)).body).snapshot.queries[0]?.state).toBe(
        "Loading",
      );
    } finally {
      await r.dispose();
    }
  }, 30_000);

  it("4. root close removes the connection; repeats and reconnects do not accumulate", async () => {
    const r = await rig();
    try {
      const view = await r.open("repeat");
      await waitAttached(r, 1);
      const rootId = await rootIdOf(view);
      const first = inspection((await inspect(r, rootId)).body);
      const baselineFinalizers = await view.evaluate<number>("window.__fixture.finalizers()");
      const baselineRecords = recordIds(first.snapshot);

      for (let index = 0; index < 30; index += 1) {
        const read = inspection((await inspect(r, rootId)).body);
        expect(recordIds(read.snapshot)).toEqual(baselineRecords);
      }

      // A pending read on an incarnation the gateway drops fails with that
      // incarnation; the reconnect is a new incarnation.
      const blocked = await busy(view, 1_000);
      const pending = inspect(r, rootId, ["--deadline", "8000"]);
      await H.waitUntil(async () => (await H.stats(r.gateway)).pendingReads === 1, "pending read");
      expect(await Effect.runPromise(r.gateway.gateway.disconnectRoot(rootId))).toBe(true);
      const dropped = await pending;
      expect(failure(dropped.body)).toEqual({
        _tag: "RootDisconnected",
        root: rootId,
        incarnation: first.root.incarnation,
      });
      await blocked.done;

      // The gateway lists an incarnation as soon as its side of the upgrade
      // completes, which can be before the page sees its socket open. A read
      // answered over the new incarnation proves both ends are open.
      const reconnected = async (after: number): Promise<number> => {
        await H.waitUntil(
          async () => (await roots(r)).roots.some((root) => root.incarnation > after),
          "reconnect",
        );
        const read = inspection((await inspect(r, rootId)).body);
        expect(read.root.incarnation).toBeGreaterThan(after);
        expect(recordIds(read.snapshot)).toEqual(baselineRecords);
        return read.root.incarnation;
      };
      let incarnation = first.root.incarnation;
      for (let index = 0; index < 10; index += 1) {
        incarnation = await reconnected(incarnation);
        await Effect.runPromise(r.gateway.gateway.disconnectRoot(rootId));
      }
      await reconnected(incarnation);

      const stats = await H.stats(r.gateway);
      expect(stats.roots).toBe(1);
      expect(stats.pendingReads).toBe(0);
      expect(stats.connectionsOpened - stats.connectionsClosed).toBe(1);
      expect(await view.evaluate<unknown>("window.__openSockets()")).toBe(1);
      expect(await view.evaluate<number>("window.__fixture.finalizers()")).toBe(baselineFinalizers);

      // Root close: the scope ends, the socket closes, the registry forgets.
      await view.evaluate<unknown>("window.__fixture.close()");
      await waitAttached(r, 0);
      const created = await view.evaluate<number>("window.__sockets.created");
      await Bun.sleep(600);
      expect(await view.evaluate<unknown>("window.__openSockets()")).toBe(0);
      expect(await view.evaluate<number>("window.__sockets.created")).toBe(created);
      expect(failure((await inspect(r, rootId)).body)._tag).toBe("RootNotFound");

      // Tab close with a read in flight fails that read, not the gateway.
      // The page holds the request frame while its thread stays idle: WebKit
      // may let a busy page finish its task and answer queued frames before
      // it tears the page down, so a busy page does not keep a read in flight.
      const tab = await r.open("tab");
      await waitAttached(r, 1);
      const tabId = await rootIdOf(tab);
      await tab.evaluate<unknown>("window.__sockets.holding = true");
      const inFlight = inspect(r, tabId, ["--deadline", "8000"]);
      await H.waitUntil(async () => (await H.stats(r.gateway)).pendingReads === 1, "tab read");
      await H.waitFor(tab, "window.__sockets.held > 0", "tab read held at the root");
      tab.close();
      const lost = await inFlight;
      expect(failure(lost.body)._tag).toBe("RootDisconnected");
      expect(await H.stats(r.gateway)).toMatchObject({ roots: 0, pendingReads: 0 });
    } finally {
      await r.dispose();
    }
  }, 60_000);

  it("5. an absent gateway does not delay mount; retry is bounded by the root scope", async () => {
    // Reserve a loopback port, then free it: nothing listens there.
    const placeholder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = placeholder.port ?? 0;
    placeholder.stop(true);

    const devPage = H.servePage((await devBundle).text);
    const prodPage = H.servePage((await prodBundle).text);
    const views: Array<Bun.WebView> = [];
    let late: H.RunningGateway | undefined;
    try {
      const prod = await H.openView(prodPage.url("/books/7", { name: "prod" }));
      views.push(prod);
      const disabled = await H.openView(devPage.url("/books/7", { name: "disabled" }));
      views.push(disabled);
      const absent = await H.openView(
        devPage.url("/books/7", {
          name: "absent",
          gateway: { url: `ws://127.0.0.1:${port}`, token: "a".repeat(64) },
        }),
      );
      views.push(absent);
      for (const view of views) {
        await H.waitFor(view, "window.__fixture && window.__fixture.mountedAt > 0", "mount");
      }
      const mountMillis = async (view: Bun.WebView) =>
        view.evaluate<number>("window.__fixture.mountedAt - window.__fixture.startedAt");
      const prodMillis = await mountMillis(prod);
      const absentMillis = await mountMillis(absent);
      expect(absentMillis).toBeLessThan(prodMillis + 100);
      expect(absentMillis).toBeLessThan(500);

      await Bun.sleep(1_200);
      // Production and the disabled development adapter never dial.
      expect(await prod.evaluate<unknown>("window.__sockets.created")).toBe(0);
      expect(await disabled.evaluate<unknown>("window.__sockets.created")).toBe(0);
      // The absent gateway gets a bounded backoff, not a hot loop.
      const attempts = await absent.evaluate<number>("window.__sockets.created");
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(attempts).toBeLessThanOrEqual(8);
      const retries = await absent.evaluate<ReadonlyArray<number>>(
        "window.__fixture.status.filter((s) => s._tag === 'Disconnected').map((s) => s.retryInMillis)",
      );
      expect(Math.max(...retries)).toBeLessThanOrEqual(400);
      // The delay doubles from 50 ms to the 400 ms cap; a constant delay fails this.
      expect(retries.length).toBeGreaterThanOrEqual(4);
      expect(retries).toEqual(retries.map((_, index) => Math.min(400, 50 * 2 ** index)));
      expect(await absent.evaluate<unknown>("Boolean(document.querySelector('#loading'))")).toBe(
        true,
      );

      // A gateway that starts later is found by the same scoped loop.
      late = await H.startGateway({ allowedOrigin: devPage.origin, port });
      const running = late;
      // The page was configured with a token this gateway did not issue.
      await Bun.sleep(900);
      expect((await H.stats(running)).roots).toBe(0);

      const lateView = await H.openView(
        devPage.url("/books/7", {
          name: "late",
          gateway: { url: `ws://127.0.0.1:${port}`, token: running.attachToken },
        }),
      );
      views.push(lateView);
      await H.waitUntil(async () => (await H.stats(running)).roots === 1, "late attach");

      // A gateway that drops the root at once does not reset the backoff:
      // only a connection that stayed open for one second does.
      const lateDelays = () =>
        lateView.evaluate<ReadonlyArray<number>>(
          "window.__fixture.status.filter((s) => s._tag === 'Disconnected').map((s) => s.retryInMillis)",
        );
      expect(await lateDelays()).toEqual([]);
      for (let drop = 0; drop < 3; drop += 1) {
        await H.waitUntil(async () => (await H.stats(running)).roots === 1, "late reattach");
        const [root] = await Effect.runPromise(running.gateway.roots);
        expect(await Effect.runPromise(running.gateway.disconnectRoot(root?.id ?? ""))).toBe(true);
      }
      await H.waitUntil(async () => (await lateDelays()).length === 3, "three late retries");
      expect(await lateDelays()).toEqual([50, 100, 200]);
      await H.waitUntil(async () => (await H.stats(running)).roots === 1, "late reattach");

      // Closing the root ends the retry loop: no more dials.
      await absent.evaluate<unknown>("window.__fixture.close()");
      await Bun.sleep(100);
      const frozen = await absent.evaluate<number>("window.__sockets.created");
      await Bun.sleep(1_000);
      expect(await absent.evaluate<number>("window.__sockets.created")).toBe(frozen);
    } finally {
      for (const view of views) view.close();
      if (late !== undefined) await late.close();
      devPage.stop();
      prodPage.stop();
    }
  }, 30_000);
});
