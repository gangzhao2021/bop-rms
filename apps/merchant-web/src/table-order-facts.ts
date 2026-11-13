import { createCurrentOrderQueueClient } from "./current-order-queue-client.js";
import {
  createDiningProgressClient,
  servableQuantity,
  type DiningProgress,
} from "./dining-progress-client.js";
import { readyToServe } from "./dining-serve-ready.js";
import {
  createDiningServeReadyClient,
  DINING_SERVE_READY_MAX_LINES,
  type DiningServeReadyResult,
} from "./dining-serve-ready-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { TableBill } from "./table-checkout-client.js";

/**
 * WP-2423 item 8 ① (the Tables page is the server's main screen): what the list needs to know of
 * each open table's Order, from the current order queue the Orders page reads — dishes ready at the
 * pass, whether the kitchen is still making something, and the table's bill. Never an amount the
 * page made up: the bill is the queue's (Payment's) own.
 */
export interface TableOrderFacts {
  readonly readyToServe: number;
  /** The kitchen is still making (or about to make) something for this table. */
  readonly inKitchen: boolean;
  /** Every dish ordered so far has been served. */
  readonly allServed: boolean;
  /** A pay-later table's bill: what it comes to, and what it paid once paid. */
  readonly bill: {
    readonly totalMinor: string;
    /** A split bill with some parts paid: what is left to collect. */
    readonly partlyPaid?: {
      readonly remainingMinor: string;
      readonly paidParts: number;
      /** Null: guests are paying by dish (no fixed number of parts). */
      readonly partCount: number | null;
    };
    readonly paid: { readonly amountMinor: string } | null;
  } | null;
}

/**
 * v15 batch 8: a table checking out whose Order the queue read did not bring (a slow or failed
 * read, or an Order past the pages read) is said from its own bill — the one the table's panel
 * shows — so a table paid in full never reads "Checking the bill". Payment's figures only; what
 * the kitchen still has is not known from the bill, so nothing is said about dishes.
 */
export function tableFactsFromBill(bill: TableBill): TableOrderFacts {
  const split = bill.split;
  const paidParts = (split?.parts ?? []).filter((part) => part.payment !== null);
  const paid =
    bill.settlement !== null
      ? { amountMinor: bill.settlement.totalMinor }
      : split !== null && split.paidInFull
        ? {
            amountMinor: paidParts
              .reduce((sum, part) => sum + BigInt(part.payment?.totalMinor ?? "0"), 0n)
              .toString(),
          }
        : null;
  return {
    readyToServe: 0,
    inKitchen: false,
    allServed: false,
    bill: {
      totalMinor: bill.settlement !== null ? bill.settlement.roundsMinor : bill.owed.totalMinor,
      ...(paid === null && split !== null && paidParts.length > 0
        ? {
            partlyPaid: {
              remainingMinor: split.remainingMinor,
              paidParts: paidParts.length,
              partCount: split.mode === "ByGuests" ? null : split.parts.length,
            },
          }
        : {}),
      paid,
    },
  };
}

/** Order phases in which the kitchen still has work for the table. */
const kitchenPhases = new Set(["Submitted", "Accepted", "InProgress"]);
/** At most this many queue pages are read to find the open tables' Orders. */
export const TABLE_ORDER_PAGES = 5;

type QueuedOrder = Awaited<
  ReturnType<ReturnType<typeof createCurrentOrderQueueClient>["load"]>
>["items"][number];
/** One Order of the queue (or its own detail read) as the Tables list says it. */
function factsOfOrder(order: QueuedOrder): TableOrderFacts {
  const ready = order.readyToServeItemCount ?? 0;
  return {
    readyToServe: ready,
    inKitchen:
      (order.remakingItemCount ?? 0) > 0 ||
      (order.currentPhase !== null && kitchenPhases.has(order.currentPhase)),
    allServed: order.currentPhase === "Fulfilled" && ready === 0,
    bill:
      order.tableBill === null
        ? null
        : {
            totalMinor: order.tableBill.totalMinor,
            ...(order.tableBill.partlyPaid === undefined
              ? {}
              : { partlyPaid: order.tableBill.partlyPaid }),
            paid:
              order.tableBill.paid === null
                ? null
                : { amountMinor: order.tableBill.paid.amountMinor },
          },
  };
}
/** At most this many tables' serving progress is read on its own in one list read. */
export const TABLE_PROGRESS_READS = 20;
const TABLE_PROGRESS_READS_AT_ONCE = 4;
const unfinished = new Set(["Submitted", "Accepted", "InProgress"]);

/**
 * v15 b13: what the kitchen and the pass hold for one table, from its serving progress — the read
 * the table's own Mark served uses — over the queue's (the bill stays the queue's or the bill's).
 */
export function kitchenFactsFromProgress(
  view: DiningProgress,
): Pick<TableOrderFacts, "readyToServe" | "inKitchen" | "allServed"> {
  const ready = readyToServe(view).reduce((sum, item) => sum + servableQuantity(item), 0);
  const live = view.items.filter((item) => item.phase !== "Cancelled" && item.phase !== "Rejected");
  return {
    readyToServe: ready,
    inKitchen:
      live.some((item) => unfinished.has(item.phase)) ||
      live.some((item) => (item.remakingQuantity ?? 0) > 0),
    allServed: live.length > 0 && live.every((item) => item.phase === "Fulfilled"),
  };
}

/** Reads each Order's serving progress on its own, a few at a time; one that fails is left out. */
async function readKitchenFacts(
  orderReferences: readonly string[],
  csrf: string,
  signal: AbortSignal,
  fetcher: typeof fetch | undefined,
): Promise<Map<string, Pick<TableOrderFacts, "readyToServe" | "inKitchen" | "allServed">>> {
  const progress = createDiningProgressClient(fetcher);
  const found = new Map<
    string,
    Pick<TableOrderFacts, "readyToServe" | "inKitchen" | "allServed">
  >();
  const toRead = [...new Set(orderReferences)].slice(0, TABLE_PROGRESS_READS);
  const worker = async () => {
    for (let next = toRead.shift(); next !== undefined; next = toRead.shift()) {
      if (signal.aborted) return;
      try {
        found.set(next, kitchenFactsFromProgress(await progress.load(next, csrf, signal)));
      } catch {
        /* Not read now: what was said before stays; the next list read tries again. */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TABLE_PROGRESS_READS_AT_ONCE, toRead.length) }, worker),
  );
  return found;
}

/**
 * v15 b13: what the kitchen and the pass hold for the tables checking out, each from its own
 * serving progress (the read the table's own Mark served uses), whatever the order queue says or
 * whether it could be read: dishes at the pass still offer Serve all on the list (v15 b12 live: a
 * table comped to $0 with 3 dishes ready read "Nothing to pay" and offered none).
 */
export function loadTableKitchenFacts(
  orderReferences: readonly string[],
  csrf: string,
  signal: AbortSignal,
  fetcher?: typeof fetch,
): Promise<ReadonlyMap<string, Pick<TableOrderFacts, "readyToServe" | "inKitchen" | "allServed">>> {
  return readKitchenFacts(orderReferences, csrf, signal, fetcher);
}

/**
 * Reads the queue until every wanted Order is found (or the queue ends). v15 b13: an open table's
 * Order the queue pages did not bring (a busy day lists more Orders than are read) is read from its
 * own serving progress, with no bill (the table's own bill says it).
 */
export async function loadTableOrderFacts(
  orderReferences: readonly string[],
  signal: AbortSignal,
  fetcher?: typeof fetch,
  own: { readonly csrf: string } | null = null,
): Promise<ReadonlyMap<string, TableOrderFacts>> {
  const wanted = new Set(orderReferences);
  const facts = new Map<string, TableOrderFacts>();
  if (wanted.size === 0) return facts;
  const client = createCurrentOrderQueueClient(fetcher);
  let after: string | null = null;
  for (let page = 0; page < TABLE_ORDER_PAGES; page++) {
    const queue = await client.load(after, signal);
    for (const order of queue.items)
      if (wanted.has(order.orderReference)) facts.set(order.orderReference, factsOfOrder(order));
    if (
      [...wanted].every((reference) => facts.has(reference)) ||
      queue.nextAfterOrderReference === null
    )
      break;
    after = queue.nextAfterOrderReference;
  }
  if (own === null) return facts;
  const missing = [...wanted].filter((reference) => !facts.has(reference));
  for (const [reference, kitchen] of await readKitchenFacts(missing, own.csrf, signal, fetcher))
    facts.set(reference, { bill: null, ...kitchen });
  return facts;
}

/**
 * "Serve all" from the list: every dish ready at the pass for this table, in one command. Serving
 * is not money, so it is not confirmed; the result is said in words. A lost answer is sent again
 * with the same operation (kept by the caller under the table's Order), so nothing is served twice.
 */
export function prepareServeAllReady(
  orderReference: string,
  csrf: string,
  fetcher?: typeof fetch,
): { execute(signal?: AbortSignal): Promise<DiningServeReadyResult | null> } {
  let prepared: { execute: (csrf: string, signal?: AbortSignal) => Promise<unknown> } | null = null;
  return {
    async execute(signal) {
      if (prepared === null) {
        const view = await createDiningProgressClient(fetcher).load(orderReference, csrf, signal);
        const lines = readyToServe(view).slice(0, DINING_SERVE_READY_MAX_LINES);
        if (lines.length === 0) return null;
        prepared = createDiningServeReadyClient(fetcher).prepare({
          operationReference: serviceOperationReference(),
          orderReference: view.orderReference,
          expectedOrderVersion: view.orderVersion,
          expectedSessionVersion: view.sessionVersion,
          expectedTableAssignmentVersion: view.tableAssignmentVersion,
          lines: lines.map((item) => ({
            orderItemReference: item.orderItemReference,
            quantity: servableQuantity(item),
            expectedItemServiceVersion: item.itemServiceVersion,
          })),
        });
      }
      return (await prepared.execute(csrf, signal)) as DiningServeReadyResult;
    },
  };
}
