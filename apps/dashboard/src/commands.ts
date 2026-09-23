import type { RemoteActorRef, Source } from "effect-frame/actor/client";
import { Effect, Stream } from "effect";
import type { Alerts, Memo, Orders } from "./contract.js";

/**
 * The three sends the dashboard makes, and the one reading every view
 * shares. A route's actor binding is a source of references: it emits a
 * new reference when the tenant moves. A send reads the current one. The
 * framework mints the command id, declares the page's active keys, and
 * applies the refreshes the reply carries; nothing here can fail, and a
 * refusal is a state of the returned handle.
 */

export type OrdersRef = RemoteActorRef<typeof Orders>;
export type AlertsRef = RemoteActorRef<typeof Alerts>;
export type MemoRef = RemoteActorRef<typeof Memo>;

export const fulfil = Effect.fn("Dashboard.fulfil")(function* (
  book: Source<OrdersRef>,
  id: string,
) {
  const current = yield* book.get;
  return yield* current.send({ _tag: "Fulfil", id });
});

export const cancel = Effect.fn("Dashboard.cancel")(function* (
  book: Source<OrdersRef>,
  id: string,
) {
  const current = yield* book.get;
  return yield* current.send({ _tag: "Cancel", id });
});

export const ack = Effect.fn("Dashboard.ack")(function* (alerts: Source<AlertsRef>, id: string) {
  const current = yield* alerts.get;
  return yield* current.send({ _tag: "Ack", id });
});

export const writeMemo = Effect.fn("Dashboard.writeMemo")(function* (
  memo: Source<MemoRef>,
  text: string,
) {
  const current = yield* memo.get;
  return yield* current.send({ _tag: "Write", text });
});

/** The snapshot of whichever reference a route binding holds now. */
export const snapshotOf = <S>(binding: Source<{ readonly state: Source<S> }>): Source<S> => ({
  get: Effect.flatMap(binding.get, (current) => current.state.get),
  changes: Stream.switchMap(binding.changes, (current) => current.state.changes),
});
