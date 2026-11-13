import type { StaffDiningTable } from "./dining-session-client.js";
import type { TableBill } from "./table-checkout-client.js";
import { lastTableBill, type LastTableBill } from "./table-last-bills.js";
import { tableFactsFromBill, type TableOrderFacts } from "./table-order-facts.js";

/**
 * v15 batch 11 (tables-list-bill-reads): the Tables list's own reads of the open tables' bills.
 * Each table is read and shown on its own: one table whose bill cannot be read (an answer of 503,
 * a read that never ends) never holds back or throws away another table's bill. Each read has a
 * time limit, and an answer is kept only when no read started later has already been kept, so a
 * late answer never puts back what a newer read replaced (a table the guest just paid on the phone
 * never goes back to "Waiting for payment").
 */
export const LIST_BILL_READ_LIMIT_MS = 15_000;
/** At most this many bills are read at once (a busy evening has many tables checking out). */
export const LIST_BILL_READS_AT_ONCE = 4;

export interface ListBill {
  /** What the bill was read for: read again when this changes. */
  readonly key: string;
  readonly bill: LastTableBill;
  readonly facts: TableOrderFacts;
  /** The read's number, counted when it started (shared with the order queue's reads). */
  readonly read: number;
}

/**
 * Reads the bills of the tables that need one now, updating `kept` (by Dining Session) as each
 * answer comes and calling `shown` after each one. A table checking out is read once per list
 * read (`poll`); another open table only when the order queue said something new about it.
 */
export async function readListBills(input: {
  readonly items: readonly StaffDiningTable[];
  readonly queued: ReadonlyMap<string, TableOrderFacts>;
  readonly poll: number;
  /** Only these tables are read now; the others keep what was read before. */
  readonly only?: ((table: StaffDiningTable) => boolean) | undefined;
  readonly kept: Map<string, ListBill>;
  readonly inFlight: Set<string>;
  /**
   * v15 b12: the tables (by Dining Session) whose last bill read ended without a bill — an error,
   * a refusal or no answer in time; a later answer takes the table off.
   */
  readonly failed?: Set<string> | undefined;
  readonly read: (diningSessionReference: string, signal: AbortSignal) => Promise<TableBill>;
  readonly nextRead: () => number;
  /** Aborted when the page is left or the sign-in ended. */
  readonly signal: AbortSignal;
  readonly shown: () => void;
  readonly limitMs?: number;
  readonly atOnce?: number;
}): Promise<void> {
  const open = new Set<string>();
  const due: { session: string; table: StaffDiningTable; key: string }[] = [];
  for (const table of input.items) {
    const session = table.currentDiningSessionReference;
    const order = table.session?.orderReference;
    if (session === null || !order) continue;
    open.add(session);
    if (input.only !== undefined && !input.only(table)) continue;
    // A table checking out is said from this bill when the queue is slow or fails, and the guest
    // may pay on the phone between two reads: it is read once in every list read, never kept stale.
    const key = JSON.stringify(
      table.session?.phase === "Closing"
        ? ["Closing", input.poll]
        : [table.session?.phase, input.queued.get(order) ?? null],
    );
    if (input.kept.get(session)?.key === key || input.inFlight.has(session)) continue;
    due.push({ session, table, key });
  }
  // A table no longer open is forgotten (its bill does not stay on this device).
  for (const session of [...input.kept.keys()]) if (!open.has(session)) input.kept.delete(session);
  for (const session of [...(input.failed ?? [])])
    if (!open.has(session)) input.failed?.delete(session);
  const limitMs = input.limitMs ?? LIST_BILL_READ_LIMIT_MS;
  const readOne = async ({ session, table, key }: (typeof due)[number]) => {
    if (input.signal.aborted) return;
    const number = input.nextRead();
    const controller = new AbortController();
    const stop = () => controller.abort();
    input.signal.addEventListener("abort", stop);
    const limit = setTimeout(stop, limitMs);
    input.inFlight.add(session);
    try {
      const bill = await input.read(session, controller.signal);
      if (controller.signal.aborted) return;
      input.failed?.delete(session);
      const prior = input.kept.get(session);
      if (prior !== undefined && prior.read > number) return;
      if (bill.paymentTiming === "PayLater")
        input.kept.set(session, {
          key,
          bill: lastTableBill(table.stableLabel, bill),
          facts: tableFactsFromBill(bill),
          read: number,
        });
      else input.kept.delete(session);
      input.shown();
    } catch {
      // Not read this time (or not allowed): what was kept for this table stays until a later read.
      // Leaving the page is not a failed read.
      if (!input.signal.aborted && input.failed !== undefined) {
        input.failed.add(session);
        input.shown();
      }
    } finally {
      clearTimeout(limit);
      input.signal.removeEventListener("abort", stop);
      input.inFlight.delete(session);
    }
  };
  const queue = [...due];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await readOne(next);
  };
  await Promise.all(
    Array.from({ length: Math.min(input.atOnce ?? LIST_BILL_READS_AT_ONCE, queue.length) }, worker),
  );
}

/** v15 b12: the Orders of the open tables whose last bill read failed. */
export function unreadBillOrders(
  items: readonly StaffDiningTable[],
  failed: ReadonlySet<string>,
): ReadonlySet<string> {
  const orders = new Set<string>();
  for (const table of items)
    if (
      table.currentDiningSessionReference !== null &&
      failed.has(table.currentDiningSessionReference) &&
      table.session?.orderReference
    )
      orders.add(table.session.orderReference);
  return orders;
}

/** The bills kept, by Order, for the list to say each table checking out from. */
export function listBillsByOrder(
  items: readonly StaffDiningTable[],
  kept: ReadonlyMap<string, ListBill>,
): ReadonlyMap<string, { readonly facts: TableOrderFacts; readonly read: number }> {
  const byOrder = new Map<string, { facts: TableOrderFacts; read: number }>();
  for (const table of items) {
    const entry =
      table.currentDiningSessionReference === null
        ? undefined
        : kept.get(table.currentDiningSessionReference);
    if (entry !== undefined && table.session?.orderReference)
      byOrder.set(table.session.orderReference, { facts: entry.facts, read: entry.read });
  }
  return byOrder;
}
