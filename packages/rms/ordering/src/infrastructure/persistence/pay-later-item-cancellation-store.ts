import { createHash } from "node:crypto";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
} from "../../domain/cart.js";
import {
  parseStaffOrderCancellationReasonCode,
  staffOrderCancellationPolicy,
  staffOrderCancellationReasonAllowed,
  StaffOrderCancellationError,
  type StaffOrderCancellationReasonCode,
} from "../../application/staff-order-cancellation.js";
import { parseStaffItemCancellationSelection } from "../../application/staff-item-cancellation.js";
import {
  decodeConfiguredOrderItemSnapshot,
  decodeOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (rule 2): staff take dishes — or a whole round — off the bill of a
 * table that pays at the end, before it pays. The same append-only item cancellation as a paid one
 * (a StaffItemCancellation revision, the kitchen's evidence, who and why), on the basis 'PayLater':
 * the round went to the kitchen unpaid, so no payment is named and nothing is refunded; the dishes
 * no longer count in the Order's priced total (the bill). The caller composes the kitchen,
 * fulfillment and stock steps in the same transaction and checks the table has not paid.
 */
export interface PayLaterItemCancellationRecord {
  readonly cancellationReference: string;
  readonly operationReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly expectedOrderVersion: number;
  readonly cancelledOrderVersion: number;
  readonly actorReference: string;
  readonly reasonCode: StaffOrderCancellationReasonCode;
  readonly orderItemReferences: readonly string[];
  readonly cancelledAt: string;
}
export interface PayLaterItemCancellationPlan {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly expectedOrderVersion: number;
  readonly expectedSourceCheckpoint: string;
  readonly lines: readonly {
    readonly orderItemReference: string;
    readonly sourceCartLineReference: string;
    readonly quantity: number;
  }[];
  readonly remainingOrderItemReferences: readonly string[];
  /** What the selected dishes came to, tax included (they leave the bill). */
  readonly amountMinor: bigint;
}
export type PayLaterItemCancellationNotEligibleReason =
  | "NotFound"
  | "NotPayLater"
  | "VersionConflict"
  | "AlreadyCancelled"
  | "Closed"
  | "Completed"
  | "ItemNotInBatch"
  | "ItemAlreadyCancelled";

const conflict = (): never => {
  throw new StaffOrderCancellationError("STAFF_ORDER_CANCELLATION_CONFLICT");
};
const unavailable = (): never => {
  throw new StaffOrderCancellationError("STAFF_ORDER_CANCELLATION_UNAVAILABLE");
};
const instant = (value: unknown) =>
  String(parseOrderingInstant(value instanceof Date ? value.toISOString() : value));
const recordSelect = `SELECT cancellation_id::text AS cancellation,operation_id::text AS operation,order_id::text AS "order",
 order_batch_id::text AS batch,submission_id::text AS submission,expected_order_version,cancelled_order_version,
 actor_id::text AS actor,reason_code,order_item_ids::text[] AS items,cancelled_at
 FROM rms_ordering.order_item_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND basis='PayLater'`;
function recordFrom(row: Record<string, unknown>): PayLaterItemCancellationRecord {
  if (!Array.isArray(row.items)) return unavailable();
  const expected = Number(row.expected_order_version);
  if (!Number.isSafeInteger(expected) || Number(row.cancelled_order_version) !== expected + 1)
    return unavailable();
  return Object.freeze({
    cancellationReference: String(parseOrderingReference(row.cancellation)),
    operationReference: String(parseOrderingReference(row.operation)),
    orderReference: String(parseOrderingReference(row.order)),
    orderBatchReference: String(parseOrderingReference(row.batch)),
    submissionReference: String(parseOrderingReference(row.submission)),
    expectedOrderVersion: expected,
    cancelledOrderVersion: expected + 1,
    actorReference: String(parseOrderingReference(row.actor)),
    reasonCode: parseStaffOrderCancellationReasonCode(row.reason_code),
    orderItemReferences: Object.freeze(
      row.items.map((item: unknown) => String(parseOrderingReference(item))),
    ),
    cancelledAt: instant(row.cancelled_at),
  });
}

export function createPostgresPayLaterItemCancellationStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, input: { orderReference: string }): Promise<boolean>;
}) {
  const brand = String(parseOrderingReference(options.brandReference)),
    store = String(parseOrderingReference(options.storeReference));
  const context = (tx: ConsumerTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const allowed = async (tx: ConsumerTransaction, orderReference: string) => {
    if ((await options.authorize(tx, { orderReference })) !== true) unavailable();
  };
  const fence = (tx: ConsumerTransaction, order: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingOrderDisposition:" + brand + ":" + store + ":" + order,
    ]);
  const single = async (tx: ConsumerTransaction, sql: string, values: readonly unknown[]) => {
    const rows = (await tx.query(sql, values)).rows;
    if (rows.length > 1) return unavailable();
    return rows[0] as Record<string, unknown> | undefined;
  };
  const records = async (tx: ConsumerTransaction, where: string, values: readonly unknown[]) => {
    await context(tx);
    const rows = (
      await tx.query(`${recordSelect} AND ${where} LIMIT 10001`, [brand, store, ...values])
    ).rows as Record<string, unknown>[];
    if (rows.length > 10000) return unavailable();
    return rows.map(recordFrom);
  };

  async function evaluate(
    tx: ConsumerTransaction,
    order: string,
    batch: string,
    selected: readonly string[],
    expectedOrderVersion: number,
  ): Promise<
    | { status: "Ready"; plan: PayLaterItemCancellationPlan; occurredAt: string }
    | { status: "NotEligible"; reason: PayLaterItemCancellationNotEligibleReason }
  > {
    const notEligible = (reason: PayLaterItemCancellationNotEligibleReason) =>
      ({ status: "NotEligible", reason }) as const;
    const header = await single(
      tx,
      "SELECT order_type FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
      [brand, store, order],
    );
    if (!header) return notEligible("NotFound");
    if (header.order_type !== "DineIn") return notEligible("NotPayLater");
    const target = await single(
      tx,
      "SELECT submission_id::text AS submission FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 FOR SHARE",
      [brand, store, order, batch],
    );
    if (!target) return notEligible("NotFound");
    const confirmed = await single(
      tx,
      "SELECT confirmed_at FROM rms_ordering.order_pay_later_confirmation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 AND submission_id=$5",
      [brand, store, order, batch, target.submission],
    );
    if (!confirmed) return notEligible("NotPayLater");
    const states = await single(
      tx,
      "SELECT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4) " +
        "OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4) " +
        "OR EXISTS (SELECT 1 FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) " +
        "OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4) AS ended," +
        "COALESCE((SELECT status FROM rms_ordering.order_closure_version WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY closure_version DESC LIMIT 1),'Open') AS closure," +
        "EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) " +
        "OR EXISTS (SELECT 1 FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND kind='Fulfillment') AS completed",
      [brand, store, order, batch],
    );
    if (!states || typeof states.ended !== "boolean" || typeof states.completed !== "boolean")
      return unavailable();
    if (states.ended) return notEligible("AlreadyCancelled");
    if (states.closure !== "Open") return notEligible("Closed");
    if (states.completed) return notEligible("Completed");
    const latest = await single(
      tx,
      "SELECT revision_id::text AS revision,version,occurred_at FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY version DESC LIMIT 1",
      [brand, store, order],
    );
    if (!latest || typeof latest.version !== "number") return unavailable();
    if (latest.version !== expectedOrderVersion) return notEligible("VersionConflict");
    const items = (
      await tx.query(
        "SELECT order_item_id::text AS item,source_cart_line_id::text AS line,quantity,transaction_snapshot_json AS snapshot," +
          "transaction_snapshot_json->'pricing'->>'quoteVersion' AS quote_version FROM rms_ordering.order_item " +
          "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 ORDER BY order_item_id LIMIT 1001",
        [brand, store, order, batch],
      )
    ).rows as Record<string, unknown>[];
    if (items.length === 0 || items.length > 1000) return unavailable();
    const cancelledRows = (
      await tx.query(
        "SELECT order_item_ids::text[] AS items FROM rms_ordering.order_item_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4",
        [brand, store, order, batch],
      )
    ).rows as Record<string, unknown>[];
    const cancelled = new Set(
      cancelledRows.flatMap((row) =>
        Array.isArray(row.items) ? row.items.map(String) : unavailable(),
      ),
    );
    const members = new Set(items.map((row) => String(row.item)));
    if (selected.some((line) => !members.has(line))) return notEligible("ItemNotInBatch");
    if (selected.some((line) => cancelled.has(line))) return notEligible("ItemAlreadyCancelled");
    let amountMinor = 0n;
    const lines = items
      .filter((row) => selected.includes(String(row.item)))
      .map((row) => {
        if (row.quote_version !== "1" && row.quote_version !== "2") return unavailable();
        const snapshot = (
          row.quote_version === "2" ? decodeConfiguredOrderItemSnapshot : decodeOrderItemSnapshot
        )(row.snapshot);
        if (snapshot.orderItemReference !== String(row.item)) return unavailable();
        amountMinor += snapshot.pricing.total.amountMinor;
        return Object.freeze({
          orderItemReference: String(parseOrderingReference(row.item)),
          sourceCartLineReference: String(parseOrderingReference(row.line)),
          quantity: Number(row.quantity),
        });
      });
    const occurredAt = [
      instant(latest.occurred_at),
      instant(confirmed.confirmed_at),
    ].sort()[1] as string;
    return {
      status: "Ready",
      plan: Object.freeze({
        orderReference: order,
        orderBatchReference: batch,
        submissionReference: String(parseOrderingReference(target.submission)),
        expectedOrderVersion: latest.version,
        expectedSourceCheckpoint: String(parseOrderingReference(latest.revision)),
        lines: Object.freeze(lines),
        remainingOrderItemReferences: Object.freeze(
          items
            .map((row) => String(row.item))
            .filter((line) => !selected.includes(line) && !cancelled.has(line)),
        ),
        amountMinor,
      }),
      occurredAt,
    };
  }

  return Object.freeze({
    /** Dishes taken off unpaid bills of these Orders, in cancellation order. */
    async listByOrders(tx: ConsumerTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return unavailable();
      const orders = orderReferences.map((value) => String(parseOrderingReference(value)));
      for (const order of orders) await allowed(tx, order);
      return Object.freeze(
        await records(tx, "order_id=ANY($3::uuid[]) ORDER BY cancelled_order_version", [orders]),
      );
    },

    async loadByOperation(tx: ConsumerTransaction, operationReference: string) {
      const found = await records(tx, "operation_id=$3", [
        String(parseOrderingReference(operationReference)),
      ]);
      if (found.length > 1) return unavailable();
      const record = found[0] ?? null;
      if (record !== null) await allowed(tx, record.orderReference);
      return record;
    },

    async prepare(
      tx: ConsumerTransaction,
      input: {
        orderReference: string;
        orderBatchReference: string;
        orderItemReferences: readonly string[];
        expectedOrderVersion: number;
      },
    ) {
      const order = String(parseOrderingReference(input.orderReference)),
        batch = String(parseOrderingReference(input.orderBatchReference));
      const selected = parseStaffItemCancellationSelection(input.orderItemReferences);
      if (!Number.isSafeInteger(input.expectedOrderVersion) || input.expectedOrderVersion < 2)
        return unavailable();
      await allowed(tx, order);
      await context(tx);
      await fence(tx, order);
      const result = await evaluate(tx, order, batch, selected, input.expectedOrderVersion);
      await allowed(tx, order);
      return result.status === "Ready"
        ? Object.freeze({ status: "Ready" as const, plan: result.plan })
        : Object.freeze(result);
    },

    async commit(
      tx: ConsumerTransaction,
      input: {
        plan: PayLaterItemCancellationPlan;
        cancellationReference: string;
        operationReference: string;
        actorReference: string;
        reasonCode: string;
        kitchenEvidenceDigest: string;
        auditReference: string;
        cancelledAt: string;
      },
    ): Promise<{ readonly status: "Created"; readonly record: PayLaterItemCancellationRecord }> {
      const plan = input.plan;
      const cancellation = String(parseOrderingReference(input.cancellationReference)),
        operation = String(parseOrderingReference(input.operationReference)),
        actor = String(parseOrderingReference(input.actorReference)),
        audit = String(parseOrderingReference(input.auditReference)),
        reasonCode = parseStaffOrderCancellationReasonCode(input.reasonCode),
        kitchenEvidenceDigest = parseOrderingHash(input.kitchenEvidenceDigest),
        cancelledAt = String(parseOrderingInstant(input.cancelledAt));
      if (!staffOrderCancellationReasonAllowed("DineIn", reasonCode))
        throw new StaffOrderCancellationError("STAFF_ORDER_CANCELLATION_INVALID");
      await allowed(tx, plan.orderReference);
      await context(tx);
      await fence(tx, plan.orderReference);
      if ((await records(tx, "operation_id=$3", [operation])).length > 0) return conflict();
      const current = await evaluate(
        tx,
        plan.orderReference,
        plan.orderBatchReference,
        plan.lines.map((line) => line.orderItemReference),
        plan.expectedOrderVersion,
      );
      if (
        current.status !== "Ready" ||
        canonicalizeRfc8785({ ...current.plan, amountMinor: String(current.plan.amountMinor) }) !==
          canonicalizeRfc8785({ ...plan, amountMinor: String(plan.amountMinor) }) ||
        cancelledAt < current.occurredAt
      )
        return conflict();
      const items = plan.lines.map((line) => line.orderItemReference);
      const sourceDigest =
        "sha256:" +
        createHash("sha256")
          .update(
            canonicalizeRfc8785({
              kind: "PayLaterItemCancellation/v1",
              plan: { ...plan, amountMinor: String(plan.amountMinor) },
              reasonCode,
              kitchenEvidenceDigest,
            }),
          )
          .digest("hex");
      const auditRecord = validateAuditRecord({
        auditId: audit,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: actor },
        actionCode: "ORDER_ITEMS_REMOVED_FROM_UNPAID_BILL",
        targetType: "OrderBatch",
        targetId: plan.orderBatchReference,
        correlationId: operation,
        reasonCode,
        occurredAt: cancelledAt,
        sourceChannel: "MERCHANT_WEB",
        afterSummary: {
          cancelledLineCount: items.length,
          remainingLineCount: plan.remainingOrderItemReferences.length,
          amountMinor: plan.amountMinor.toString(),
        },
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      await tx.query("SAVEPOINT ordering_pay_later_item_cancellation", []);
      try {
        const revision = await tx.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) " +
            "SELECT $4::uuid,$1::uuid,$2::uuid,$3::uuid,'StaffItemCancellation',$5::integer,$6::integer,r.revision_id,NULL,$7::timestamptz FROM rms_ordering.order_revision r " +
            "WHERE r.brand_id=$1::uuid AND r.store_id=$2::uuid AND r.order_id=$3::uuid AND r.version=$6::integer AND r.occurred_at<=$7::timestamptz AND r.revision_id=$8::uuid",
          [
            brand,
            store,
            plan.orderReference,
            cancellation,
            plan.expectedOrderVersion + 1,
            plan.expectedOrderVersion,
            cancelledAt,
            plan.expectedSourceCheckpoint,
          ],
        );
        if (revision.rowCount !== 1) return conflict();
        const inserted = await tx.query(
          "INSERT INTO rms_ordering.order_item_staff_cancellation (cancellation_id,operation_id,brand_id,store_id,order_id,order_batch_id,submission_id,order_type," +
            "expected_order_version,cancelled_order_version,expected_source_checkpoint,previous_phase,actor_id,permission_code,reason_code," +
            "order_item_ids,kitchen_evidence_digest,currency_code,source_digest,audit_id,cancelled_at,basis) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,'DineIn',$8,$9,$10,'Accepted',$11,$12,$13,$14::uuid[],$15,'CAD',$16,$17,$18,'PayLater')",
          [
            cancellation,
            operation,
            brand,
            store,
            plan.orderReference,
            plan.orderBatchReference,
            plan.submissionReference,
            plan.expectedOrderVersion,
            plan.expectedOrderVersion + 1,
            plan.expectedSourceCheckpoint,
            actor,
            staffOrderCancellationPolicy.permissionCode,
            reasonCode,
            items,
            kitchenEvidenceDigest,
            sourceDigest,
            audit,
            cancelledAt,
          ],
        );
        if (inserted.rowCount !== 1) return conflict();
        await appendAuditRecordInTransaction(tx, auditRecord);
        await tx.query("RELEASE SAVEPOINT ordering_pay_later_item_cancellation", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_pay_later_item_cancellation", []);
        await tx.query("RELEASE SAVEPOINT ordering_pay_later_item_cancellation", []);
        return conflict();
      }
      const [saved] = await records(tx, "cancellation_id=$3", [cancellation]);
      if (saved === undefined) return unavailable();
      return Object.freeze({ status: "Created" as const, record: saved });
    },
  });
}
