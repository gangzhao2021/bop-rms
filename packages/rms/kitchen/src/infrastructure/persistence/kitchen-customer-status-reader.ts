import type { ConsumerTransaction } from "@bop/eventing";
import { KitchenWorkLifecycleError } from "../../contracts/kitchen-work-lifecycle.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../../domain/kitchen-ticket.js";

export interface KitchenCustomerBatchStatus {
  readonly orderBatchReference: string;
  readonly ticketReference: string;
  readonly ticketVersion: bigint;
  readonly updatedAt: string;
  readonly status: "Queued" | "InProgress" | "Ready";
  readonly items: readonly {
    readonly orderItemReference: string;
    readonly status: "Queued" | "InProgress" | "Ready";
  }[];
}

function unavailable(): never {
  throw new KitchenWorkLifecycleError("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
}

/** Customer-safe owner facts. Caller must compare batches with Ordering's complete batch set.
 * Tenant context and transaction lifetime belong to the caller; no freshness is inferred across domains.
 */
export function createPostgresKitchenCustomerStatusReader(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly authorize: (
    transaction: ConsumerTransaction,
    scope: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
    },
  ) => Promise<boolean>;
}) {
  const brandReference = parseKitchenTicketReference(options.brandReference);
  const storeReference = parseKitchenTicketReference(options.storeReference);
  return {
    async loadByOrder(input: {
      readonly transaction: ConsumerTransaction;
      readonly orderReference: string;
    }) {
      try {
        const orderReference = parseKitchenTicketReference(input.orderReference);
        const scope = { brandReference, storeReference, orderReference };
        if ((await options.authorize(input.transaction, scope)) !== true) return unavailable();
        // Lifecycle writers lock the ticket before changing any work item or ready result.
        const tickets = await input.transaction.query(
          "SELECT kitchen_ticket_id,order_batch_id,aggregate_version::text AS version,status,updated_at " +
            "FROM rms_kitchen.kitchen_ticket WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 " +
            "ORDER BY kitchen_ticket_id LIMIT 21 FOR SHARE",
          [brandReference, storeReference, orderReference],
        );
        if (tickets.rows.length === 0) return null;
        if (tickets.rows.length > 20) return unavailable();
        const batches: KitchenCustomerBatchStatus[] = [];
        for (const ticket of tickets.rows) {
          const ticketReference = parseKitchenTicketReference(ticket.kitchen_ticket_id);
          const orderBatchReference = parseKitchenTicketReference(ticket.order_batch_id);
          if (
            ticket.status !== "Open" ||
            typeof ticket.version !== "string" ||
            !/^[1-9][0-9]{0,18}$/.test(ticket.version) ||
            BigInt(ticket.version) > 9223372036854775807n ||
            batches.some((batch) => batch.orderBatchReference === orderBatchReference)
          )
            return unavailable();
          const updatedAt = parseKitchenTicketInstant(
            ticket.updated_at instanceof Date ? ticket.updated_at.toISOString() : ticket.updated_at,
          );
          const items = await input.transaction.query(
            "SELECT w.kitchen_work_item_id,w.order_item_id,w.status,w.required_quantity,w.completed_quantity," +
              "r.ready_result_id,r.ready_quantity,r.required_quantity AS ready_required_quantity " +
              "FROM rms_kitchen.kitchen_work_item w LEFT JOIN rms_kitchen.kitchen_order_item_ready_result r " +
              "ON r.brand_id=w.brand_id AND r.store_id=w.store_id AND r.kitchen_ticket_id=w.kitchen_ticket_id AND r.order_item_id=w.order_item_id " +
              "WHERE w.brand_id=$1 AND w.store_id=$2 AND w.kitchen_ticket_id=$3 ORDER BY w.kitchen_work_item_id LIMIT 1001",
            [brandReference, storeReference, ticketReference],
          );
          if (items.rows.length === 0 || items.rows.length > 1000) return unavailable();
          const seen = new Set<string>();
          const itemStates = new Map<string, { allReady: boolean; allQueued: boolean }>();
          let allReady = true;
          let allQueued = true;
          for (const item of items.rows) {
            const reference = parseKitchenTicketReference(item.kitchen_work_item_id);
            const orderItemReference = parseKitchenTicketReference(item.order_item_id);
            if (seen.has(reference)) return unavailable();
            seen.add(reference);
            if (
              !["Queued", "In Progress", "Completed"].includes(String(item.status)) ||
              !Number.isSafeInteger(item.required_quantity) ||
              Number(item.required_quantity) <= 0 ||
              Number(item.required_quantity) > 999 ||
              !Number.isSafeInteger(item.completed_quantity) ||
              Number(item.completed_quantity) < 0 ||
              Number(item.completed_quantity) > Number(item.required_quantity)
            )
              return unavailable();
            if (
              (item.status === "Queued" && item.completed_quantity !== 0) ||
              (item.status === "Completed" && item.completed_quantity !== item.required_quantity) ||
              (item.status === "In Progress" &&
                Number(item.completed_quantity) >= Number(item.required_quantity))
            )
              return unavailable();
            allQueued = allQueued && item.status === "Queued";
            const ready = item.ready_result_id !== null;
            if (ready) {
              parseKitchenTicketReference(item.ready_result_id);
              if (
                item.ready_quantity !== item.ready_required_quantity ||
                item.ready_required_quantity !== item.required_quantity ||
                item.completed_quantity !== item.required_quantity ||
                item.status !== "Completed"
              )
                return unavailable();
            }
            allReady = allReady && ready;
            const prior = itemStates.get(orderItemReference);
            itemStates.set(orderItemReference, {
              allReady: (prior?.allReady ?? true) && ready,
              allQueued: (prior?.allQueued ?? true) && item.status === "Queued",
            });
          }
          batches.push({
            orderBatchReference,
            ticketReference,
            ticketVersion: BigInt(ticket.version),
            updatedAt,
            status: allReady ? "Ready" : allQueued ? "Queued" : "InProgress",
            items: Object.freeze(
              [...itemStates].map(([orderItemReference, state]) =>
                Object.freeze({
                  orderItemReference,
                  status: state.allReady
                    ? ("Ready" as const)
                    : state.allQueued
                      ? ("Queued" as const)
                      : ("InProgress" as const),
                }),
              ),
            ),
          });
        }
        return { ...scope, batches };
      } catch {
        return unavailable();
      }
    },
  };
}
