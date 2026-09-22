import type { ConsumerTransaction } from "@bop/eventing";
import { decodeKitchenTicketCreationRecord } from "../../application/kitchen-ticket-creation-record.js";
import type { KitchenTicketEffectValidationPorts } from "../../application/ports/kitchen-ticket-ports.js";
import { decodeKitchenWorkLifecycleRecord } from "../../application/kitchen-work-lifecycle-record.js";
import type { KitchenWorkLifecycleEffectValidationPorts } from "../../application/kitchen-work-lifecycle-service.js";
import { createKitchenQueueLifecycleProofBundle } from "../../application/kitchen-queue-lifecycle-proof.js";
import {
  KitchenQueueProjectionError,
  parseKitchenQueueLifecycleRebuildSourceFeed,
} from "../../domain/kitchen-queue-projection.js";
import { parseKitchenTicketReference } from "../../domain/kitchen-ticket.js";

function unavailable(): never {
  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
}
function rows(value: unknown, limit: number): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some((row) => row === null || typeof row !== "object" || Array.isArray(row))
  )
    return unavailable();
  return value;
}
const instant = (value: unknown) => {
  if (!(typeof value === "string" || value instanceof Date)) return unavailable();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return unavailable();
  return date.toISOString();
};
const version = (value: unknown) => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return unavailable();
  return BigInt(value);
};

/** One SQL statement supplies one MVCC snapshot even under READ COMMITTED.
 * Caller owns scoped transaction/timeouts. Snapshot IDs are not durable consumer offsets.
 */
export function createPostgresKitchenQueueSourceReader(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly maxTickets: number;
  readonly maxItemsPerTicket: number;
  readonly maxOperationsPerTicket: number;
  readonly creationValidation: KitchenTicketEffectValidationPorts;
  readonly lifecycleValidation: KitchenWorkLifecycleEffectValidationPorts;
  readonly nextSnapshotReference: () => string;
  readonly authorize: (transaction: ConsumerTransaction) => Promise<boolean>;
}) {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  const limits = [options.maxTickets, options.maxItemsPerTicket, options.maxOperationsPerTicket];
  if (limits.some((limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > 100000))
    return unavailable();
  return {
    async read(transaction: ConsumerTransaction) {
      try {
        if ((await options.authorize(transaction)) !== true) return unavailable();
        const result = await transaction.query(
          "SELECT clock_timestamp() AS as_of,COALESCE(jsonb_agg(s), '[]'::jsonb) AS tickets FROM (" +
            "SELECT t.kitchen_ticket_id,t.order_id,t.order_batch_id,t.source_event_id,t.status," +
            "t.aggregate_version::text AS version,t.updated_at,r.creation_record_json::text AS record,r.effect_digest," +
            "(SELECT COALESCE(jsonb_agg(i),'[]'::jsonb) FROM (SELECT kitchen_work_item_id,order_item_id,source_item_ordinal,split_ordinal," +
            "version::text AS version,status,required_quantity,completed_quantity,created_at,updated_at " +
            "FROM rms_kitchen.kitchen_work_item WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=t.kitchen_ticket_id ORDER BY kitchen_work_item_id LIMIT $4) i) AS items," +
            "(SELECT COALESCE(jsonb_agg(o),'[]'::jsonb) FROM (SELECT kitchen_work_lifecycle_operation_id,idempotency_key,effect_digest,effect_record_json::text AS record " +
            "FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=t.kitchen_ticket_id " +
            "AND idempotency_key IS NOT NULL ORDER BY result_ticket_version LIMIT $5) o) AS operations," +
            "(SELECT COALESCE(jsonb_agg(a),'[]'::jsonb) FROM (SELECT ready_result_id,order_item_id,causal_operation_id,work_items_digest,ready_quantity,required_quantity,ready_at " +
            "FROM rms_kitchen.kitchen_order_item_ready_result WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=t.kitchen_ticket_id ORDER BY ready_result_id LIMIT $4) a) AS ready " +
            "FROM (SELECT * FROM rms_kitchen.kitchen_ticket WHERE brand_id=$1 AND store_id=$2 AND status='Open' ORDER BY kitchen_ticket_id LIMIT $3) t " +
            "LEFT JOIN rms_kitchen.kitchen_creation_record r ON r.brand_id=t.brand_id AND r.store_id=t.store_id AND r.kitchen_ticket_id=t.kitchen_ticket_id) s",
          [
            brand,
            store,
            options.maxTickets + 1,
            options.maxItemsPerTicket + 1,
            options.maxOperationsPerTicket + 1,
          ],
        );
        if (result.rows.length !== 1 || !result.rows[0]) return unavailable();
        const snapshot = result.rows[0];
        const tickets = rows(snapshot.tickets, options.maxTickets).map((row) => {
          const creation = decodeKitchenTicketCreationRecord(
            row.record,
            options.creationValidation,
          );
          const original = creation.ticket;
          if (
            original.brandReference !== brand ||
            original.storeReference !== store ||
            original.ticketReference !== row.kitchen_ticket_id ||
            original.orderReference !== row.order_id ||
            original.orderBatchReference !== row.order_batch_id ||
            original.sourceEventReference !== row.source_event_id ||
            creation.effectDigest !== row.effect_digest ||
            row.status !== "Open"
          )
            return unavailable();
          const history = rows(row.operations, options.maxOperationsPerTicket).map((record) => {
            const effect = decodeKitchenWorkLifecycleRecord(
              record.record,
              options.lifecycleValidation,
            );
            if (
              effect.command.brandReference !== brand ||
              effect.command.storeReference !== store ||
              effect.operation.ticketReference !== original.ticketReference ||
              effect.operation.operationReference !== record.kitchen_work_lifecycle_operation_id ||
              effect.operation.idempotencyKey !== record.idempotency_key ||
              effect.effectDigest !== record.effect_digest
            )
              return unavailable();
            return effect;
          });
          const ready = history.flatMap((effect) =>
            effect.readyResult ? [effect.readyResult] : [],
          );
          const storedReady = rows(row.ready, options.maxItemsPerTicket);
          if (storedReady.length !== ready.length) return unavailable();
          for (const proof of ready) {
            const stored = storedReady.find(
              (item) => item.ready_result_id === proof.readyResultReference,
            );
            if (
              !stored ||
              stored.order_item_id !== proof.orderItemReference ||
              stored.causal_operation_id !== proof.causalOperationReference ||
              stored.work_items_digest !== proof.workItemsDigest ||
              stored.ready_quantity !== proof.readyQuantity ||
              stored.required_quantity !== proof.requiredQuantity ||
              instant(stored.ready_at) !== proof.readyAt
            )
              return unavailable();
          }
          const ticketVersion = version(row.version);
          const storedItems = rows(row.items, options.maxItemsPerTicket);
          if (storedItems.length !== original.workItems.length) return unavailable();
          const items = storedItems.map((item) => {
            const initial = original.workItems.find(
              (value) => value.workItemReference === item.kitchen_work_item_id,
            );
            if (
              !initial ||
              initial.orderItemReference !== item.order_item_id ||
              initial.sourceOrdinal !== item.source_item_ordinal ||
              initial.splitOrdinal !== item.split_ordinal ||
              initial.requiredQuantity !== item.required_quantity ||
              initial.createdAt !== instant(item.created_at)
            )
              return unavailable();
            const operations = history.filter(
              (effect) => effect.mutation.workItemReference === initial.workItemReference,
            );
            const latest = operations.at(-1);
            const itemVersion = version(item.version);
            if (
              latest
                ? latest.mutation.resultWorkItemVersion !== itemVersion ||
                  latest.mutation.afterStatus !== item.status ||
                  latest.mutation.afterCompletedQuantity !== item.completed_quantity ||
                  latest.mutation.updatedAt !== instant(item.updated_at)
                : itemVersion !== 1n ||
                  item.status !== "Queued" ||
                  item.completed_quantity !== 0 ||
                  instant(item.updated_at) !== initial.createdAt
            )
              return unavailable();
            return {
              ticketReference: original.ticketReference,
              workItemReference: initial.workItemReference,
              orderReference: original.orderReference,
              orderBatchReference: original.orderBatchReference,
              orderItemReference: initial.orderItemReference,
              sourceItemOrdinal: initial.sourceOrdinal,
              ticketAggregateVersion: ticketVersion,
              workItemVersion: itemVersion,
              status: item.status,
              requiredQuantity: initial.requiredQuantity,
              completedQuantity: item.completed_quantity,
              localizedDisplayNames: initial.localizedDisplayNames,
              selectedOptions: initial.selectedOptions,
              stationReference: initial.stationRouting.stationReference,
              workItemCreatedAt: initial.createdAt,
              acceptedAt:
                operations.find(
                  (effect) => effect.operation.actionCode === "KITCHEN_WORK_ITEM_ACCEPTED",
                )?.operation.occurredAt ?? null,
              orderItemReadyAt:
                ready.find((value) => value.orderItemReference === initial.orderItemReference)
                  ?.readyAt ?? null,
              catalogSnapshotControlled: true,
            };
          });
          if (
            ticketVersion !== (history.at(-1)?.mutation.resultTicketVersion ?? 1n) ||
            instant(row.updated_at) !== (history.at(-1)?.mutation.updatedAt ?? original.createdAt)
          )
            return unavailable();
          return {
            brandReference: brand,
            storeReference: store,
            ticketReference: original.ticketReference,
            orderReference: original.orderReference,
            orderBatchReference: original.orderBatchReference,
            ticketAggregateVersion: ticketVersion,
            ticketStatus: "Open",
            updatedAt: instant(row.updated_at),
            sourceEvent: creation.event,
            items,
            proofBundle: createKitchenQueueLifecycleProofBundle({
              ticketReference: original.ticketReference,
              effects: history,
              validation: options.lifecycleValidation,
            }),
          };
        });
        const feed = {
          brandReference: brand,
          storeReference: store,
          sourceCheckpointReference: parseKitchenTicketReference(options.nextSnapshotReference()),
          asOfUtc: instant(snapshot.as_of),
          coverageStatus: "CompleteThroughCheckpoint",
          tickets,
        };
        parseKitchenQueueLifecycleRebuildSourceFeed(
          feed,
          options.lifecycleValidation.digests.sha256,
        );
        if ((await options.authorize(transaction)) !== true) return unavailable();
        return feed;
      } catch {
        return unavailable();
      }
    },
  };
}
