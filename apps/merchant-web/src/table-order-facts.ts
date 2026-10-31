import { createCurrentOrderQueueClient } from "./current-order-queue-client.js";
import { createDiningProgressClient, servableQuantity } from "./dining-progress-client.js";
import { readyToServe } from "./dining-serve-ready.js";
import {
  createDiningServeReadyClient,
  DINING_SERVE_READY_MAX_LINES,
  type DiningServeReadyResult,
} from "./dining-serve-ready-client.js";
import { serviceOperationReference } from "./service-control-client.js";

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
    readonly paid: { readonly amountMinor: string } | null;
  } | null;
}

/** Order phases in which the kitchen still has work for the table. */
const kitchenPhases = new Set(["Submitted", "Accepted", "InProgress"]);
/** At most this many queue pages are read to find the open tables' Orders. */
export const TABLE_ORDER_PAGES = 5;

/** Reads the queue until every wanted Order is found (or the queue ends). */
export async function loadTableOrderFacts(
  orderReferences: readonly string[],
  signal: AbortSignal,
  fetcher?: typeof fetch,
): Promise<ReadonlyMap<string, TableOrderFacts>> {
  const wanted = new Set(orderReferences);
  const facts = new Map<string, TableOrderFacts>();
  if (wanted.size === 0) return facts;
  const client = createCurrentOrderQueueClient(fetcher);
  let after: string | null = null;
  for (let page = 0; page < TABLE_ORDER_PAGES; page++) {
    const queue = await client.load(after, signal);
    for (const order of queue.items) {
      if (!wanted.has(order.orderReference)) continue;
      const ready = order.readyToServeItemCount ?? 0;
      facts.set(order.orderReference, {
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
                paid:
                  order.tableBill.paid === null
                    ? null
                    : { amountMinor: order.tableBill.paid.amountMinor },
              },
      });
    }
    if (
      [...wanted].every((reference) => facts.has(reference)) ||
      queue.nextAfterOrderReference === null
    )
      break;
    after = queue.nextAfterOrderReference;
  }
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
