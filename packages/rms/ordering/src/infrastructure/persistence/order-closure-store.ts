import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  canonicalizeRfc8785,
} from "@bop/audit";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import {
  parseOrderClosureRecord,
  type OrderClosureRecord,
} from "../../domain/order-closure-record.js";
import { evaluateOrderClosureEligibility } from "../../domain/order-closure-eligibility.js";
import { createPostgresOrderClosurePosition } from "./order-closure-position.js";
const fail = (): never => {
  throw new Error("ORDER_CLOSURE_STORE_UNAVAILABLE");
};
const columns = {
  closureReference: "closure_id",
  operationReference: "operation_id",
  tenantReference: "tenant_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  closureVersion: "closure_version",
  orderVersion: "order_version",
  previousClosureReference: "previous_closure_id",
  status: "status",
  actorType: "actor_type",
  actorReference: "actor_id",
  reasonCode: "reason_code",
  financialFinalityReference: "financial_finality_id",
  evidenceDigest: "evidence_digest",
  occurredAt: "occurred_at",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[],
  selection = keys.map((key) => columns[key] + ' AS "' + key + '"').join(",");
/** Server-only writer. Evidence ports retain owner fences through this transaction.
 * Reopen evidence includes manager qualification and both unlocked period decisions. */
export function createPostgresOrderClosureStore(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  authorize(tx: ConsumerTransaction, record: OrderClosureRecord): Promise<boolean>;
  closeEvidence(tx: ConsumerTransaction, record: OrderClosureRecord): Promise<unknown>;
  reopenEvidence(tx: ConsumerTransaction, record: OrderClosureRecord): Promise<unknown>;
  audit(record: OrderClosureRecord): Promise<unknown>;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.tenantReference),
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  };
  return Object.freeze({
    /** Historical operation receipt, not current closure status. The caller's lookup
     * authority must bind its current actor/scope before even an absence is disclosed. */
    async readOperation(
      tx: ConsumerTransaction,
      input: { orderReference: string; operationReference: string; observedAt: string },
      authorizeLookup: (
        tx: ConsumerTransaction,
        query: { orderReference: string; operationReference: string; observedAt: string },
      ) => Promise<boolean>,
    ) {
      try {
        const raw = readClosedRecord(input, ["orderReference", "operationReference", "observedAt"]);
        const query = Object.freeze({
          orderReference: String(parseOrderingReference(raw.orderReference)),
          operationReference: String(parseOrderingReference(raw.operationReference)),
          observedAt: String(parseOrderingInstant(raw.observedAt)),
        });
        const authorize = async () => {
          if ((await authorizeLookup(tx, query)) !== true) return fail();
        };
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        for (const key of [
          "OrderingOrderDisposition:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            query.orderReference,
          "OrderingClosureOperation:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            query.operationReference,
        ])
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
        const result = await tx.query(
          "SELECT " +
            selection +
            " FROM rms_ordering.order_closure_version WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
          [scope.brandReference, scope.storeReference, query.operationReference],
        );
        if (result.rows.length > 1) return fail();
        const row = result.rows[0];
        if (!row) {
          await authorize();
          return null;
        }
        const record = parseOrderClosureRecord({
          ...row,
          occurredAt:
            row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
        });
        if (
          record.tenantReference !== scope.tenantReference ||
          record.brandReference !== scope.brandReference ||
          record.storeReference !== scope.storeReference ||
          record.orderReference !== query.orderReference ||
          record.operationReference !== query.operationReference ||
          record.occurredAt > query.observedAt ||
          (await options.authorize(tx, record)) !== true
        )
          return fail();
        await authorize();
        return record;
      } catch {
        return fail();
      }
    },
    async commit(tx: ConsumerTransaction, input: unknown) {
      try {
        const record = parseOrderClosureRecord(input);
        if (
          record.tenantReference !== scope.tenantReference ||
          record.brandReference !== scope.brandReference ||
          record.storeReference !== scope.storeReference ||
          (await options.authorize(tx, record)) !== true
        )
          return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        for (const key of [
          "OrderingOrderDisposition:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            record.orderReference,
          "OrderingClosureOperation:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            record.operationReference,
        ])
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
        const prior = await tx.query(
          "SELECT " +
            selection +
            " FROM rms_ordering.order_closure_version WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
          [scope.brandReference, scope.storeReference, record.operationReference],
        );
        if (prior.rows.length > 1) return fail();
        if (prior.rows[0]) {
          const row = prior.rows[0],
            saved = parseOrderClosureRecord({
              ...row,
              occurredAt:
                row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
            });
          if (
            keys.some((key) => saved[key] !== record[key]) ||
            (await options.authorize(tx, record)) !== true
          )
            return fail();
          return Object.freeze({ status: "AlreadyCommitted" as const, record: saved });
        }
        const current = await createPostgresOrderClosurePosition({
          ...scope,
          authorize: () => options.authorize(tx, record),
        })(tx, { orderReference: record.orderReference, observedAt: record.occurredAt });
        if (
          current.orderVersion !== record.orderVersion ||
          current.closureVersion + 1 !== record.closureVersion ||
          current.closureReference !== record.previousClosureReference ||
          current.status === record.status
        )
          return fail();
        const evidence =
          record.status === "Closed"
            ? await options.closeEvidence(tx, record)
            : await options.reopenEvidence(tx, record);
        if (record.status === "Closed") {
          const decision = evaluateOrderClosureEligibility(evidence);
          const financial = Object.getOwnPropertyDescriptor(evidence, "financialFinality")
            ?.value as unknown;
          const fact = readClosedRecord(financial, [
            "orderReference",
            "class",
            "ownerFinalityReference",
            "decidedAt",
          ]);
          if (
            !decision.eligible ||
            decision.brandReference !== scope.brandReference ||
            decision.storeReference !== scope.storeReference ||
            decision.orderReference !== record.orderReference ||
            decision.orderVersion !== record.orderVersion ||
            decision.observedAt !== record.occurredAt ||
            fact.ownerFinalityReference !== record.financialFinalityReference
          )
            return fail();
        } else {
          const decision = readClosedRecord(evidence, [
            "brandReference",
            "storeReference",
            "orderReference",
            "orderVersion",
            "observedAt",
            "actorReference",
            "managerQualified",
            "settlementPeriodUnlocked",
            "accountingPeriodUnlocked",
            "ownerEvidenceReference",
          ]);
          parseOrderingReference(decision.ownerEvidenceReference);
          if (
            decision.brandReference !== scope.brandReference ||
            decision.storeReference !== scope.storeReference ||
            decision.orderReference !== record.orderReference ||
            decision.orderVersion !== record.orderVersion ||
            parseOrderingInstant(decision.observedAt) !== record.occurredAt ||
            decision.actorReference !== record.actorReference ||
            decision.managerQualified !== true ||
            decision.settlementPeriodUnlocked !== true ||
            decision.accountingPeriodUnlocked !== true
          )
            return fail();
        }
        if (
          "sha256:" + createHash("sha256").update(canonicalizeRfc8785(evidence)).digest("hex") !==
          record.evidenceDigest
        )
          return fail();
        const audit = validateAuditRecord(await options.audit(record));
        if (
          audit.brandId !== scope.brandReference ||
          audit.storeId !== scope.storeReference ||
          audit.actor.type !== record.actorType ||
          (audit.actor.type === "User" && audit.actor.reference !== record.actorReference) ||
          audit.actionCode !== "ORDER_CLOSURE_RECORDED" ||
          audit.targetType !== "Order" ||
          audit.targetId !== record.orderReference ||
          audit.correlationId !== record.operationReference ||
          audit.reasonCode !== record.reasonCode ||
          audit.occurredAt !== record.occurredAt ||
          audit.beforeSummary !== undefined ||
          JSON.stringify(audit.afterSummary) !==
            JSON.stringify({ status: record.status, closureVersion: record.closureVersion }) ||
          audit.dataClassification !== "Restricted"
        )
          return fail();
        if ((await options.authorize(tx, record)) !== true) return fail();
        await tx.query("SAVEPOINT ordering_closure_append", []);
        try {
          const inserted = await tx.query(
            "INSERT INTO rms_ordering.order_closure_version (" +
              keys.map((key) => columns[key]).join(",") +
              ") VALUES (" +
              keys.map((_, i) => "$" + (i + 1)).join(",") +
              ")",
            keys.map((key) => record[key]),
          );
          if (inserted.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query("RELEASE SAVEPOINT ordering_closure_append", []);
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT ordering_closure_append", []);
          throw error;
        }
        return Object.freeze({ status: "Committed" as const, record });
      } catch {
        return fail();
      }
    },
  });
}
