import type { ConsumerTransaction } from "@bop/eventing";
import {
  KitchenQueueProjectionError,
  parseKitchenQueueListQuery,
  parseKitchenQueueGetQuery,
  parseKitchenQueueRow,
  parseKitchenQueueStoredGeneration,
} from "../../domain/kitchen-queue-projection.js";
import { parseKitchenTicketReference } from "../../domain/kitchen-ticket.js";
import type {
  KitchenQueueProjectionPorts,
  KitchenQueueQueryInput,
} from "../../application/ports/kitchen-queue-projection-ports.js";

export const generationColumns = {
  projectionGenerationReference: "projection_generation_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  projectionName: "projection_name",
  projectionVersion: "projection_version",
  generationStatus: "generation_status",
  sourceCheckpointReference: "source_checkpoint_reference",
  sourceEventBindingDigest: "source_event_binding_digest",
  queueSnapshotDigest: "queue_snapshot_digest",
  ticketCount: "ticket_count",
  workItemCount: "work_item_count",
  initializedEmpty: "initialized_empty",
  asOfUtc: "as_of_utc",
  projectedAt: "projected_at",
  lastRebuiltAt: "last_rebuilt_at",
  freshnessStatus: "freshness_status",
  rebuildReference: "rebuild_reference",
  rebuildRequestDigest: "rebuild_request_digest",
  rebuildRequestedAt: "rebuild_requested_at",
  expectedPriorGenerationReference: "expected_prior_generation_id",
  snapshotBindingVersion: "snapshot_binding_version",
} as const;
export const rowColumns = {
  projectionGenerationReference: "projection_generation_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  ticketReference: "kitchen_ticket_id",
  workItemReference: "kitchen_work_item_id",
  orderReference: "order_id",
  orderBatchReference: "order_batch_id",
  orderItemReference: "order_item_id",
  sourceItemOrdinal: "source_item_ordinal",
  ticketAggregateVersion: "ticket_aggregate_version",
  workItemVersion: "work_item_version",
  status: "status",
  requiredQuantity: "required_quantity",
  completedQuantity: "completed_quantity",
  localizedDisplayNames: "localized_display_names_json",
  selectedOptions: "selected_options_json",
  stationReference: "station_id",
  originalSourceEventReference: "original_source_event_id",
  sourceEventSemanticDigest: "source_event_semantic_digest",
  sourceEventOccurredAt: "source_event_occurred_at",
  workItemCreatedAt: "work_item_created_at",
  acceptedAt: "accepted_at",
  orderItemReadyAt: "order_item_ready_at",
} as const;
const select = (columns: Readonly<Record<string, string>>) =>
  Object.entries(columns)
    .map(([key, column]) => column + ' AS "' + key + '"')
    .join(",");
export const generationSelect = select(generationColumns);
export const rowSelect = select(rowColumns);
function unavailable(): never {
  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
}
function normalize(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}
export function rowValue(raw: Record<string, unknown>) {
  const row = normalize(raw);
  // pg bigint must remain exact; numbers are not a supported adapter representation.
  for (const key of ["ticketAggregateVersion", "workItemVersion"]) {
    const value = row[key];
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return unavailable();
    row[key] = BigInt(value);
  }
  return parseKitchenQueueRow(row);
}

export function generationValue(raw: Record<string, unknown>) {
  const value = normalize(raw);
  value.activationLagMs = Date.parse(String(value.projectedAt)) - Date.parse(String(value.asOfUtc));
  return parseKitchenQueueStoredGeneration(value);
}

/** Caller owns one bounded Repeatable Read/read-only transaction across both reads.
 * No active generation is not an empty queue. Only Kitchen-owned projection tables are read.
 */
export function createPostgresKitchenQueueQueries(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, query: KitchenQueueQueryInput): Promise<boolean>;
}): KitchenQueueProjectionPorts["queries"] {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  async function authorize(tx: ConsumerTransaction, query: KitchenQueueQueryInput) {
    if (
      query.brandReference !== brand ||
      query.storeReference !== store ||
      (await options.authorize(tx, query)) !== true
    )
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
  }
  async function generation(tx: ConsumerTransaction) {
    const result = await tx.query(
      "SELECT " +
        generationSelect +
        " FROM rms_kitchen.kitchen_work_queue_projection_generation WHERE brand_id=$1 AND store_id=$2" +
        " AND projection_name='kitchen_work_queue_v1' AND projection_version=1 AND generation_status='Active' LIMIT 2",
      [brand, store],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return unavailable();
    const parsed = generationValue(result.rows[0] ?? {});
    if (
      parsed.brandReference !== brand ||
      parsed.storeReference !== store ||
      parsed.generationStatus !== "Active"
    )
      return unavailable();
    return parsed;
  }
  return {
    async list(input) {
      try {
        const query = parseKitchenQueueListQuery(input.query),
          tx = input.transaction;
        await authorize(tx, query);
        const active = await generation(tx);
        if (!active) {
          await authorize(tx, query);
          return { status: "NoActive" };
        }
        const f = query.filters,
          cursor = query.cursor;
        const result = await tx.query(
          "SELECT " +
            rowSelect +
            " FROM rms_kitchen.kitchen_work_queue_projection WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3" +
            " AND ($4::uuid IS NULL OR order_id=$4) AND ($5::uuid IS NULL OR kitchen_ticket_id=$5)" +
            " AND ($6::uuid IS NULL OR kitchen_work_item_id=$6) AND ($7::uuid IS NULL OR station_id=$7)" +
            " AND ($8::text IS NULL OR status=$8)" +
            " AND ($9::timestamptz IS NULL OR (work_item_created_at,kitchen_work_item_id)>($9,$10::uuid))" +
            " ORDER BY work_item_created_at,kitchen_work_item_id LIMIT $11",
          [
            brand,
            store,
            active.projectionGenerationReference,
            f.orderReference,
            f.ticketReference,
            f.workItemReference,
            f.stationReference,
            f.status,
            cursor?.afterCreatedAt ?? null,
            cursor?.afterWorkItemReference ?? null,
            query.limit + 1,
          ],
        );
        if (result.rows.length > query.limit + 1) return unavailable();
        const parsed = result.rows.map(rowValue);
        if (
          parsed.some(
            (row) =>
              row.brandReference !== brand ||
              row.storeReference !== store ||
              row.projectionGenerationReference !== active.projectionGenerationReference,
          )
        )
          return unavailable();
        await authorize(tx, query);
        const rows = parsed.slice(0, query.limit);
        return {
          status: "Found",
          generation: active,
          rows,
          returnedCount: rows.length,
          hasMore: parsed.length > query.limit,
        };
      } catch (error) {
        if (error instanceof KitchenQueueProjectionError) throw error;
        return unavailable();
      }
    },
    async get(input) {
      try {
        const query = parseKitchenQueueGetQuery(input.query),
          tx = input.transaction;
        await authorize(tx, query);
        const active = await generation(tx);
        if (!active) {
          await authorize(tx, query);
          return { status: "NoActive" };
        }
        const result = await tx.query(
          "SELECT " +
            rowSelect +
            " FROM rms_kitchen.kitchen_work_queue_projection WHERE brand_id=$1 AND store_id=$2" +
            " AND projection_generation_id=$3 AND kitchen_work_item_id=$4 LIMIT 2",
          [brand, store, active.projectionGenerationReference, query.workItemReference],
        );
        if (result.rows.length > 1) return unavailable();
        await authorize(tx, query);
        if (!result.rows.length) return { status: "NotFound" };
        const row = rowValue(result.rows[0] ?? {});
        if (
          row.brandReference !== brand ||
          row.storeReference !== store ||
          row.projectionGenerationReference !== active.projectionGenerationReference ||
          row.workItemReference !== query.workItemReference
        )
          return unavailable();
        return { status: "Found", generation: active, row };
      } catch (error) {
        if (error instanceof KitchenQueueProjectionError) throw error;
        return unavailable();
      }
    },
  };
}

/** Installs already-authorized Store context and shares the generation writer's lock. */
export async function lockPostgresKitchenQueueRead(input: {
  brandReference: string;
  storeReference: string;
  transaction: ConsumerTransaction;
}): Promise<void> {
  const brand = parseKitchenTicketReference(input.brandReference);
  const store = parseKitchenTicketReference(input.storeReference);
  await input.transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  await input.transaction.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
    brand + ":" + store + ":kitchen_work_queue_v1",
  ]);
}
