import { AsyncLocalStorage } from "node:async_hooks";

/**
 * WP-2423 (rush-connection-hold, v15 2026-11-14): which pool connections the current work holds.
 *
 * In every rush wave the API's whole pool (20 connections) sat "idle in transaction" for 10-20 s:
 * each transaction held its connection and asked the same pool for a second one, which waited
 * behind hundreds of guest reads for connections that only the waiting transactions could give
 * back. Nothing was answered until the request's 10 s acquire budget ran out and every hold let go
 * at once. A connection must never be waited for while one of the same pool is held: the
 * transaction runner notes here each transaction it holds open (`holdConnection`), and the
 * acquire answers a request that already holds one only from a connection free at that moment
 * (`holdsConnectionOf`, connection-acquire). The store is process-wide, as the request budget's.
 */
export interface ConnectionHold {
  /** The pool the held connection came from (set when the transaction begins). */
  pool: object | null;
  /** True from the moment the connection is held until it is given back. */
  active: boolean;
  readonly parent: ConnectionHold | undefined;
}
const holdKey = Symbol.for("bop.database.connection-hold");
function holds(): AsyncLocalStorage<ConnectionHold> {
  const holder = globalThis as { [holdKey]?: AsyncLocalStorage<ConnectionHold> };
  holder[holdKey] ??= new AsyncLocalStorage<ConnectionHold>();
  return holder[holdKey];
}
/** A hold for work that will take its connection later (inactive until `begin`). */
export function newConnectionHold(): ConnectionHold {
  return { pool: null, active: false, parent: holds().getStore() };
}
/** Runs `work` with `hold` noted as held by it (and by everything it starts). */
export function runHoldingConnection<T>(hold: ConnectionHold, work: () => T): T {
  return holds().run(hold, work);
}
/** The hold's connection of `pool` is now held. */
export function beginConnectionHold(hold: ConnectionHold, pool: object): void {
  hold.pool = pool;
  hold.active = true;
}
/** The hold's connection was given back: what the work still runs holds none of it. */
export function endConnectionHold(hold: ConnectionHold): void {
  hold.active = false;
}
/** True when the current work already holds a connection of `pool` (a transaction still open). */
export function holdsConnectionOf(pool: object): boolean {
  for (let hold = holds().getStore(); hold !== undefined; hold = hold.parent)
    if (hold.active && hold.pool === pool) return true;
  return false;
}
