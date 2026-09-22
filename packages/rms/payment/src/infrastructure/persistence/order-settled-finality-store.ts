import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  createPostgresOrderRevisionPosition,
  createPostgresOrderPricedAmountSource,
} from "@rms/ordering";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  parseOrderSettledFinality,
  settledFinalityColumns,
  type OrderSettledFinality,
} from "../../application/order-settled-finality.js";
import { assessOrderSettlement } from "../../domain/order-settlement.js";
import { createPostgresOrderFinancialPosition } from "../order-financial-position.js";
const fail = (): never => {
  throw new Error("ORDER_SETTLED_FINALITY_UNAVAILABLE");
};
const keys = Object.keys(settledFinalityColumns) as (keyof typeof settledFinalityColumns)[];
const selection = keys
  .map(
    (key) =>
      settledFinalityColumns[key] + (key.endsWith("Minor") ? "::text" : "") + ' AS "' + key + '"',
  )
  .join(",");
/** Recomputes owner facts, then atomically records settlement and Audit. Caller owns
 * transaction lifetime; historical replay does not prove present-day financial state. */
export function createPostgresOrderSettledFinalityStore(
  options: Parameters<typeof createPostgresOrderFinancialPosition>[0] & {
    audit(record: OrderSettledFinality): Promise<unknown>;
  },
) {
  const scope = Object.freeze({
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  const providerAccountReference = String(parsePaymentReference(options.providerAccountReference)),
    environment = options.environment;
  if (environment !== "Test" && environment !== "Live") return fail();
  const financial = createPostgresOrderFinancialPosition({
    ...options,
    scope,
    providerAccountReference,
    environment,
  });
  const ordering = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: options.authorize,
  };
  const revisionSource = createPostgresOrderRevisionPosition(ordering),
    pricedSource = createPostgresOrderPricedAmountSource(ordering);
  return Object.freeze({
    /** Historical owner fact only. Current balances/refunds require a fresh financial position. */
    async readFinality(tx: ConsumerTransaction, input: unknown) {
      try {
        const raw = exactPaymentObject(input, [
          "finalityReference",
          "orderReference",
          "expectedOrderVersion",
          "observedAt",
        ]);
        const finalityReference = String(parsePaymentReference(raw.finalityReference));
        const query = {
          orderReference: String(parsePaymentReference(raw.orderReference)),
          observedAt: String(parsePaymentInstant(raw.observedAt)),
        };
        if (
          !Number.isSafeInteger(raw.expectedOrderVersion) ||
          (raw.expectedOrderVersion as number) < 1 ||
          (raw.expectedOrderVersion as number) > 2147483647
        )
          return fail();
        if ((await options.authorize(tx, query)) !== true) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const found = await tx.query(
          "SELECT " +
            selection +
            " FROM rms_payment.order_settled_finality WHERE brand_id=$1 AND store_id=$2 AND provider_account_id=$3 AND environment=$4 AND finality_id=$5 AND order_id=$6",
          [
            scope.brandReference,
            scope.storeReference,
            providerAccountReference,
            environment,
            finalityReference,
            query.orderReference,
          ],
        );
        if (found.rows.length > 1) return fail();
        const row = found.rows[0];
        const record = row
          ? parseOrderSettledFinality({
              ...row,
              decidedAt:
                row.decidedAt instanceof Date ? row.decidedAt.toISOString() : row.decidedAt,
            })
          : null;
        if (
          record &&
          (record.tenantReference !== scope.tenantReference ||
            record.brandReference !== scope.brandReference ||
            record.storeReference !== scope.storeReference ||
            record.providerAccountReference !== providerAccountReference ||
            record.environment !== environment ||
            record.finalityReference !== finalityReference ||
            record.orderReference !== query.orderReference ||
            record.orderVersion !== raw.expectedOrderVersion ||
            record.decidedAt > query.observedAt)
        )
          return fail();
        if ((await options.authorize(tx, query)) !== true) return fail();
        return record;
      } catch {
        return fail();
      }
    },
    async commit(tx: ConsumerTransaction, input: unknown) {
      try {
        const raw = exactPaymentObject(input, [
          "finalityReference",
          "operationReference",
          "orderReference",
          "expectedOrderVersion",
          "observedAt",
        ]);
        const finalityReference = String(parsePaymentReference(raw.finalityReference)),
          operationReference = String(parsePaymentReference(raw.operationReference));
        const query = {
          orderReference: String(parsePaymentReference(raw.orderReference)),
          observedAt: String(parsePaymentInstant(raw.observedAt)),
        };
        if (
          !Number.isSafeInteger(raw.expectedOrderVersion) ||
          (raw.expectedOrderVersion as number) < 1 ||
          (raw.expectedOrderVersion as number) > 2147483647
        )
          return fail();
        const expectedOrderVersion = raw.expectedOrderVersion as number;
        const authorize = async () => {
          if ((await options.authorize(tx, query)) !== true) return fail();
        };
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const replay = async () => {
          const prior = await tx.query(
            "SELECT " +
              selection +
              " FROM rms_payment.order_settled_finality WHERE brand_id=$1 AND store_id=$2 AND provider_account_id=$3 AND environment=$4 AND operation_id=$5",
            [
              scope.brandReference,
              scope.storeReference,
              providerAccountReference,
              environment,
              operationReference,
            ],
          );
          if (prior.rows.length > 1) return fail();
          const row = prior.rows[0];
          if (!row) return null;
          const record = parseOrderSettledFinality({
            ...row,
            decidedAt: row.decidedAt instanceof Date ? row.decidedAt.toISOString() : row.decidedAt,
          });
          if (
            record.tenantReference !== scope.tenantReference ||
            record.brandReference !== scope.brandReference ||
            record.storeReference !== scope.storeReference ||
            record.providerAccountReference !== providerAccountReference ||
            record.environment !== environment ||
            record.operationReference !== operationReference ||
            record.finalityReference !== finalityReference ||
            record.orderReference !== query.orderReference ||
            record.orderVersion !== expectedOrderVersion ||
            record.decidedAt !== query.observedAt
          )
            return fail();
          await authorize();
          return Object.freeze({ status: "AlreadyCommitted" as const, record });
        };
        const original = await replay();
        if (original) return original;
        const revision = await revisionSource(tx, query),
          priced = await pricedSource(tx, query);
        if (revision.version !== expectedOrderVersion) return fail();
        for (const source of [revision, priced])
          if (
            source.brandReference !== scope.brandReference ||
            source.storeReference !== scope.storeReference ||
            source.orderReference !== query.orderReference ||
            source.observedAt !== query.observedAt
          )
            return fail();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentFinalityOperation:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            providerAccountReference +
            ":" +
            environment +
            ":" +
            operationReference,
        ]);
        const concurrent = await replay();
        if (concurrent) return concurrent;
        const position = await financial(tx, query);
        if (
          position.tenantReference !== scope.tenantReference ||
          position.brandReference !== scope.brandReference ||
          position.storeReference !== scope.storeReference ||
          position.orderReference !== query.orderReference ||
          position.observedAt !== query.observedAt ||
          position.providerAccountReference !== providerAccountReference ||
          position.environment !== environment
        )
          return fail();
        const assessment = assessOrderSettlement({
          currencyCode: position.currencyCode,
          pricedOrderTotalMinor: priced.pricedTotalMinor,
          capturedMinor: position.capturedMinor,
          capturedOrderAllocationMinor: position.capturedOrderAllocationMinor,
          capturedTipMinor: position.capturedTipMinor,
          confirmedRefundMinor: position.confirmedRefundMinor,
          refundAllocation: position.refundAllocation,
          pendingRefundMinor: position.pendingRefundMinor,
          unresolvedAttemptCount: position.unresolvedAttemptCount,
          pendingAmendmentCount: priced.pendingAmendmentCount,
        });
        if (assessment.classification !== "Settled") return fail();
        if (
          !/^sha256:[a-f0-9]{64}$/u.test(revision.snapshotDigest) ||
          !/^sha256:[a-f0-9]{64}$/u.test(priced.snapshotDigest)
        )
          return fail();
        const record = parseOrderSettledFinality({
          ...scope,
          providerAccountReference,
          environment,
          finalityReference,
          operationReference,
          orderReference: query.orderReference,
          orderVersion: revision.version,
          orderCheckpoint: revision.checkpoint,
          classification: "Settled",
          currencyCode: "CAD",
          pricedOrderTotalMinor: priced.pricedTotalMinor.toString(),
          capturedMinor: position.capturedMinor.toString(),
          capturedOrderAllocationMinor: position.capturedOrderAllocationMinor.toString(),
          capturedTipMinor: position.capturedTipMinor.toString(),
          orderEvidenceDigest:
            "sha256:" +
            createHash("sha256")
              .update(JSON.stringify([revision.snapshotDigest, priced.snapshotDigest]))
              .digest("hex"),
          paymentEvidenceDigest: position.snapshotDigest,
          decidedAt: query.observedAt,
        });
        const audit = validateAuditRecord(await options.audit(record));
        if (
          audit.brandId !== scope.brandReference ||
          audit.storeId !== scope.storeReference ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDER_FINANCIAL_FINALITY_RECORDED" ||
          audit.targetType !== "Order" ||
          audit.targetId !== query.orderReference ||
          audit.correlationId !== operationReference ||
          audit.occurredAt !== query.observedAt ||
          audit.reasonCode !== "ORDER_SETTLED" ||
          audit.beforeSummary !== undefined ||
          JSON.stringify(audit.afterSummary) !== JSON.stringify({ classification: "Settled" }) ||
          audit.dataClassification !== "Restricted"
        )
          return fail();
        await authorize();
        await tx.query("SAVEPOINT payment_order_finality", []);
        try {
          const result = await tx.query(
            "INSERT INTO rms_payment.order_settled_finality (" +
              keys.map((key) => settledFinalityColumns[key]).join(",") +
              ") VALUES (" +
              keys.map((_, i) => "$" + (i + 1)).join(",") +
              ")",
            keys.map((key) => record[key]),
          );
          if (result.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await tx.query("RELEASE SAVEPOINT payment_order_finality", []);
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT payment_order_finality", []);
          throw error;
        }
        return Object.freeze({ status: "Committed" as const, record });
      } catch {
        return fail();
      }
    },
  });
}
