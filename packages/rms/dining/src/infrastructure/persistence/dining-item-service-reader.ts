import { parseDiningReference, parseDiningInstant } from "../../domain/dining-session.js";
import { parseDiningItemServiceRecord } from "../../domain/dining-item-service-record.js";
import type { DiningTableTransaction, DiningTableStoreScope } from "./dining-table-store.js";

export interface DiningItemServiceQuery {
  readonly diningSessionReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly observedAt: string;
}
export class DiningItemServiceReadError extends Error {
  readonly code = "DINING_ITEM_SERVICE_READ_UNAVAILABLE";
  constructor() {
    super("dining item service read unavailable");
    this.name = "DiningItemServiceReadError";
  }
}
const fail = (): never => {
  throw new DiningItemServiceReadError();
};

/** Caller retains Ordering membership/version fences through transaction completion.
 * This query proves service history only, never readiness, permission to serve or closure.
 */
export function createPostgresDiningItemServiceReader(options: {
  scope: DiningTableStoreScope;
  authorize(
    tx: DiningTableTransaction,
    query: DiningItemServiceQuery & DiningTableStoreScope,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  });
  return Object.freeze({
    async load(input: DiningItemServiceQuery & { transaction: DiningTableTransaction }) {
      try {
        const tx = input.transaction;
        const query = Object.freeze({
          ...scope,
          diningSessionReference: parseDiningReference(input.diningSessionReference),
          orderReference: parseDiningReference(input.orderReference),
          orderBatchReference: parseDiningReference(input.orderBatchReference),
          orderItemReference: parseDiningReference(input.orderItemReference),
          observedAt: parseDiningInstant(input.observedAt),
        });
        if ((await options.authorize(tx, query)) !== true) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const key = scope.tenantReference + ":" + scope.brandReference + ":" + scope.storeReference;
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "DiningItemService:" + key + ":" + query.orderItemReference,
        ]);
        // Do not filter away a mismatched session/batch: that must reject, not look unserved.
        const result = (await tx.query(
          "SELECT record_json FROM rms_dining.dining_item_service_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND order_item_id=$4 ORDER BY version LIMIT 1000",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            query.orderItemReference,
          ],
        )) as { rows?: Record<string, unknown>[] };
        if (!Array.isArray(result.rows) || result.rows.length > 999) return fail();
        let servedQuantity = 0;
        let itemServiceVersion = 0;
        let lastServedAt: string | null = null;
        let lastRecordedAt: string | null = null;
        const services = new Set<string>();
        const operations = new Set<string>();
        const audits = new Set<string>();
        for (const row of result.rows) {
          const fact = parseDiningItemServiceRecord(row.record_json);
          if (
            fact.tenantReference !== scope.tenantReference ||
            fact.brandReference !== scope.brandReference ||
            fact.storeReference !== scope.storeReference ||
            fact.diningSessionReference !== query.diningSessionReference ||
            fact.orderReference !== query.orderReference ||
            fact.orderBatchReference !== query.orderBatchReference ||
            fact.orderItemReference !== query.orderItemReference ||
            fact.expectedItemServiceVersion !== itemServiceVersion ||
            fact.recordedAt > query.observedAt ||
            (lastServedAt !== null && fact.servedAt < lastServedAt) ||
            (lastRecordedAt !== null && fact.recordedAt < lastRecordedAt) ||
            services.has(fact.serviceReference) ||
            operations.has(fact.operationReference) ||
            audits.has(fact.auditReference)
          )
            return fail();
          services.add(fact.serviceReference);
          operations.add(fact.operationReference);
          audits.add(fact.auditReference);
          servedQuantity += fact.quantity;
          if (servedQuantity > 999) return fail();
          itemServiceVersion = fact.itemServiceVersion;
          lastServedAt = fact.servedAt;
          lastRecordedAt = fact.recordedAt;
        }
        if ((await options.authorize(tx, query)) !== true) return fail();
        return Object.freeze({
          ...query,
          servedQuantity,
          itemServiceVersion,
          lastServedAt,
        });
      } catch {
        return fail();
      }
    },
  });
}
