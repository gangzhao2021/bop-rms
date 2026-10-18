import { createDiningTable } from "../../domain/dining-table.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { parseDiningReference, parseDiningSession } from "../../domain/dining-session.js";
import {
  parseDiningItemServiceRecord,
  validateDiningItemServiceAppend,
  type DiningItemServiceRecord,
} from "../../domain/dining-item-service-record.js";
import type { DiningTableTransaction, DiningTableStoreScope } from "./dining-table-store.js";

export class DiningItemServiceStoreError extends Error {
  readonly code = "DINING_ITEM_SERVICE_UNAVAILABLE";
  constructor() {
    super("dining item service unavailable");
    this.name = "DiningItemServiceStoreError";
  }
}
const fail = (): never => {
  throw new DiningItemServiceStoreError();
};
async function rows(tx: DiningTableTransaction, sql: string, values: readonly unknown[]) {
  const result = (await tx.query(sql, values)) as { rows?: Record<string, unknown>[] };
  if (!Array.isArray(result.rows)) return fail();
  return result.rows;
}
/** Caller retains Ordering/session/table source fences before entering this store.
 * New writes validate current source under those fences. Caller owns commit/rollback.
 */
export function createPostgresDiningItemServiceStore(options: {
  scope: DiningTableStoreScope;
  authorize(tx: DiningTableTransaction, record: DiningItemServiceRecord): Promise<boolean>;
  validateCurrent(
    tx: DiningTableTransaction,
    record: DiningItemServiceRecord,
  ): Promise<{ orderedQuantity: number; readyQuantity: number }>;
  audit(record: DiningItemServiceRecord): Promise<unknown>;
}) {
  const scope = {
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  };
  return Object.freeze({
    async commit(input: { transaction: DiningTableTransaction; record: unknown }) {
      try {
        const record = parseDiningItemServiceRecord(input.record),
          tx = input.transaction;
        if (
          record.tenantReference !== scope.tenantReference ||
          record.brandReference !== scope.brandReference ||
          record.storeReference !== scope.storeReference
        )
          return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        if ((await options.authorize(tx, record)) !== true) return fail();
        const key = scope.tenantReference + ":" + scope.brandReference + ":" + scope.storeReference;
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "DiningItemServiceOperation:" + key + ":" + record.operationReference,
        ]);
        const prior = await rows(
          tx,
          "SELECT record_json FROM rms_dining.dining_item_service_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            record.operationReference,
          ],
        );
        if (prior.length > 1) return fail();
        if (prior.length === 1) {
          const original = parseDiningItemServiceRecord(prior[0]?.record_json);
          if (JSON.stringify(original) !== JSON.stringify(record)) return fail();
          return Object.freeze({ status: "AlreadyCommitted" as const, record: original });
        }
        // Match Dining Move: table before session, retained through caller commit.
        const tables = await rows(
          tx,
          "SELECT table_snapshot FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            record.tableReference,
          ],
        );
        if (tables.length !== 1) return fail();
        const table = createDiningTable(tables[0]?.table_snapshot);
        if (
          table.tenantReference !== scope.tenantReference ||
          table.brandReference !== scope.brandReference ||
          table.storeReference !== scope.storeReference ||
          table.tableReference !== record.tableReference ||
          table.activeDiningSessionReference !== record.diningSessionReference ||
          table.lifecycle !== "Published" ||
          table.operationalState !== "Available" ||
          table.observedAt > record.servedAt
        )
          return fail();
        const sessions = await rows(
          tx,
          "SELECT session_snapshot FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            record.diningSessionReference,
          ],
        );
        if (sessions.length !== 1) return fail();
        const session = parseDiningSession(sessions[0]?.session_snapshot);
        if (
          session.diningSessionReference !== record.diningSessionReference ||
          session.brandReference !== scope.brandReference ||
          session.storeReference !== scope.storeReference ||
          session.tableReference !== record.tableReference ||
          session.tableAssignmentVersion !== record.tableAssignmentVersion ||
          session.version !== record.sessionVersion ||
          session.phase !== "Active" ||
          session.startedAt > record.servedAt
        )
          return fail();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "DiningItemService:" + key + ":" + record.orderItemReference,
        ]);
        const history = await rows(
          tx,
          "SELECT record_json FROM rms_dining.dining_item_service_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND order_item_id=$4 ORDER BY version LIMIT 1000",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            record.orderItemReference,
          ],
        );
        const quantities = await options.validateCurrent(tx, record);
        validateDiningItemServiceAppend({
          record,
          history: history.map((row) => row.record_json),
          ...quantities,
        });
        const audit = validateAuditRecord(await options.audit(record));
        if (
          audit.auditId !== record.auditReference ||
          audit.brandId !== scope.brandReference ||
          audit.storeId !== scope.storeReference ||
          audit.actor.type !== "User" ||
          audit.actor.reference !== record.actorReference ||
          audit.actionCode !== "DINING_ITEM_SERVED" ||
          audit.targetType !== "OrderItem" ||
          audit.targetId !== record.orderItemReference ||
          audit.correlationId !== record.operationReference ||
          audit.occurredAt !== record.recordedAt ||
          audit.beforeSummary !== undefined ||
          JSON.stringify(audit.afterSummary) !==
            JSON.stringify({ quantity: record.quantity, version: record.itemServiceVersion }) ||
          audit.dataClassification !== "Restricted"
        )
          return fail();
        if ((await options.authorize(tx, record)) !== true) return fail();
        await tx.query("SAVEPOINT dining_item_service_append", []);
        try {
          await tx.query(
            "INSERT INTO rms_dining.dining_item_service_record (tenant_id,brand_id,store_id,session_id,order_id,order_batch_id,order_item_id,service_id,operation_id,audit_id,version,previous_version,quantity,served_at,recorded_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              record.diningSessionReference,
              record.orderReference,
              record.orderBatchReference,
              record.orderItemReference,
              record.serviceReference,
              record.operationReference,
              record.auditReference,
              record.itemServiceVersion,
              record.expectedItemServiceVersion === 0 ? null : record.expectedItemServiceVersion,
              record.quantity,
              record.servedAt,
              record.recordedAt,
              JSON.stringify(record),
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query("RELEASE SAVEPOINT dining_item_service_append", []);
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT dining_item_service_append", []);
          await tx.query("RELEASE SAVEPOINT dining_item_service_append", []);
          return fail();
        }
        return Object.freeze({ status: "Created" as const, record });
      } catch {
        return fail();
      }
    },
  });
}

/** Durable retry lookup. Caller first takes the same Ordering/Kitchen fences as the
 * serving writer, then retains this operation fence through subsequent append/commit. */
export function createPostgresDiningItemServiceOperationReader(options: {
  scope: DiningTableStoreScope;
  authorize(tx: DiningTableTransaction, operationReference: string): Promise<boolean>;
}) {
  const scope = {
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  };
  return Object.freeze({
    async load(input: { transaction: DiningTableTransaction; operationReference: string }) {
      try {
        const operation = parseDiningReference(input.operationReference),
          tx = input.transaction;
        if ((await options.authorize(tx, operation)) !== true) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "DiningItemServiceOperation:" +
            scope.tenantReference +
            ":" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            operation,
        ]);
        const found = await rows(
          tx,
          "SELECT record_json FROM rms_dining.dining_item_service_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
          [scope.tenantReference, scope.brandReference, scope.storeReference, operation],
        );
        if (found.length > 1 || (await options.authorize(tx, operation)) !== true) return fail();
        if (found.length === 0) return null;
        const record = parseDiningItemServiceRecord(found[0]?.record_json);
        if (
          record.operationReference !== operation ||
          record.tenantReference !== scope.tenantReference ||
          record.brandReference !== scope.brandReference ||
          record.storeReference !== scope.storeReference
        )
          return fail();
        return record;
      } catch {
        return fail();
      }
    },
  });
}
