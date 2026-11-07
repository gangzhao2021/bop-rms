import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  parseOrderCapacityLink,
  type OrderCapacityLink,
} from "../../domain/order-capacity-link.js";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import {
  parseOrderTerminationRecord,
  type OrderTerminationRecord,
} from "../../application/order-termination-record.js";
import {
  createPostgresOrderInitialExecutionReader,
  createPostgresOrderTerminationStore,
  createPostgresPickupOrderCompletionLookup,
} from "./order-termination-store.js";

/**
 * WP-2423 Q12: code-owned System policy that closes an unpaid pickup Order once its payment window
 * ended. The window itself (payment request + 30 minutes) is fixed by Fulfillment and Payment, so
 * this is a fixed System transition, not a Store-configurable workflow; its references identify
 * this policy version in the termination history.
 */
export const pickupPaymentWindowClosurePolicy = Object.freeze({
  reasonCode: "PAYMENT_WINDOW_EXPIRED",
  purposeCode: "PickupPaymentWindowClosure",
  permissionCode: "order.payment-window.close",
  workflowVersionReference: "019a0c00-2423-7012-8000-000000000001",
  transitionReference: "019a0c00-2423-7012-8000-000000000002",
} as const);

export type PickupPaymentWindowEvidence =
  "NoPaymentStarted" | "PaymentUnresolved" | "PaymentFailed";
const evidenceValues: readonly PickupPaymentWindowEvidence[] = [
  "NoPaymentStarted",
  "PaymentUnresolved",
  "PaymentFailed",
];
const fail = (): never => {
  throw new Error("PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE");
};
const sha256 = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
const scoped = (tx: ConsumerTransaction, brand: string, store: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
/** One closure operation per Order: retries and concurrent workers resolve to the same operation. */
function closureOperationReference(brand: string, store: string, order: string) {
  const h = createHash("sha256")
    .update(canonicalizeRfc8785(["PickupPaymentWindowClosure/v1", brand, store, order]))
    .digest("hex");
  return parseOrderingReference(
    order.slice(0, 14) + "7" + h.slice(0, 3) + "-8" + h.slice(3, 6) + "-" + h.slice(6, 18),
  );
}

/**
 * Discovery only: pickup Orders still Submitted with no recorded payment (no payment wait or
 * outcome), no acceptance, termination or completion, whose capacity link is at least 30 minutes
 * old (no payment window can end earlier). The closure decides the actual window from Fulfillment
 * and Payment under fences; a scan result never authorizes a closure.
 */
export function createPostgresPickupPaymentWindowCandidates(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, observedAt: string): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async discover(transaction: ConsumerTransaction, value: unknown) {
      try {
        const raw = readClosedRecord(value, ["observedAt", "after", "limit"]);
        const at = parseOrderingInstant(raw.observedAt),
          after = raw.after === null ? null : parseOrderingReference(raw.after),
          limit = raw.limit;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (await options.authorize(transaction, at)) !== true
        )
          return fail();
        await scoped(transaction, brand, store);
        const found = await transaction.query(
          `SELECT h.order_id::text AS "orderReference",b.order_batch_id::text AS "orderBatchReference",l.link_json AS link
          FROM rms_ordering.order_header h
          JOIN rms_ordering.order_batch b ON b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.order_id=h.order_id
          JOIN rms_ordering.order_capacity_link l ON l.brand_id=b.brand_id AND l.store_id=b.store_id
            AND l.order_id=b.order_id AND l.order_batch_id=b.order_batch_id AND l.submission_id=b.submission_id
          WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_type='Pickup' AND l.link_json->>'owner'='Fulfillment'
            AND l.created_at<=$3::timestamptz-interval '30 minutes' AND b.submitted_at<=$3::timestamptz
            AND ($4::uuid IS NULL OR h.order_id>$4::uuid)
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t
              WHERE t.brand_id=h.brand_id AND t.store_id=h.store_id AND t.order_id=h.order_id)
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a
              WHERE a.brand_id=h.brand_id AND a.store_id=h.store_id AND a.order_id=h.order_id)
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record c
              WHERE c.brand_id=h.brand_id AND c.store_id=h.store_id AND c.order_id=h.order_id)
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_acceptance_wait w
              WHERE w.brand_id=h.brand_id AND w.store_id=h.store_id AND w.order_id=h.order_id)
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d
              WHERE d.brand_id=h.brand_id AND d.store_id=h.store_id AND d.order_id=h.order_id)
          ORDER BY h.order_id LIMIT $5`,
          [brand, store, at, after, limit],
        );
        if (!Array.isArray(found.rows) || found.rows.length > limit) return fail();
        let previous = after;
        const candidates = found.rows.map((value) => {
          const row = readClosedRecord(value, ["orderReference", "orderBatchReference", "link"]);
          const orderReference = parseOrderingReference(row.orderReference),
            orderBatchReference = parseOrderingReference(row.orderBatchReference);
          const link = parseOrderCapacityLink(row.link);
          if (
            link.owner !== "Fulfillment" ||
            link.brandReference !== brand ||
            link.storeReference !== store ||
            link.orderReference !== orderReference ||
            link.orderBatchReference !== orderBatchReference ||
            (previous !== null && orderReference <= previous)
          )
            return fail();
          previous = orderReference;
          return Object.freeze({ orderReference, orderBatchReference, link });
        });
        if ((await options.authorize(transaction, at)) !== true) return fail();
        return Object.freeze(candidates);
      } catch {
        return fail();
      }
    },
  });
}

export type PickupPaymentWindowClosureResult = Readonly<
  | { status: "Closed" | "AlreadyClosed"; record: OrderTerminationRecord }
  /** Accepted/terminated otherwise, or a payment is recorded: the paid-outcome path owns it. */
  | { status: "NotEligible"; reason: "Accepted" | "Terminated" | "PaymentRecorded" }
>;

/**
 * Closes one unpaid pickup Order as Cancelled by the System (append-only Ordering termination with
 * Audit). The caller has decided from Fulfillment and Payment, under its own retained fences, that
 * the payment window ended without a captured payment, and owns the transaction (roll back on any
 * thrown failure). Replay of the same Order returns AlreadyClosed and writes nothing.
 */
export function createPostgresPickupPaymentWindowClosure(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    identity: Readonly<{ orderReference: string; orderBatchReference: string }>,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  const paymentRecorded = async (tx: ConsumerTransaction, order: string) => {
    const result = await tx.query(
      "SELECT (SELECT count(*)::int FROM rms_ordering.order_payment_acceptance_wait WHERE brand_id=$1 AND store_id=$2 AND order_id=$3)+" +
        "(SELECT count(*)::int FROM rms_ordering.order_payment_disposition_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) AS n",
      [brand, store, order],
    );
    const n = result.rows[0]?.n;
    if (result.rows.length !== 1 || typeof n !== "number") return fail();
    return n !== 0;
  };
  const linked = async (tx: ConsumerTransaction, link: OrderCapacityLink) => {
    const result = await tx.query(
      "SELECT link_json AS link FROM rms_ordering.order_capacity_link WHERE brand_id=$1 AND store_id=$2 AND submission_id=$3",
      [brand, store, link.submissionReference],
    );
    return (
      result.rows.length === 1 &&
      canonicalizeRfc8785(parseOrderCapacityLink(result.rows[0]?.link)) ===
        canonicalizeRfc8785(link)
    );
  };
  return Object.freeze({
    async close(transaction: ConsumerTransaction, value: unknown) {
      const raw = readClosedRecord(value, [
        "link",
        "windowEndedAt",
        "closedAt",
        "paymentEvidence",
        "terminationReference",
        "auditReference",
      ]);
      const link = parseOrderCapacityLink(raw.link);
      const windowEndedAt = parseOrderingInstant(raw.windowEndedAt),
        closedAt = parseOrderingInstant(raw.closedAt),
        terminationReference = parseOrderingReference(raw.terminationReference),
        auditReference = parseOrderingReference(raw.auditReference);
      const paymentEvidence = raw.paymentEvidence as PickupPaymentWindowEvidence;
      if (
        link.owner !== "Fulfillment" ||
        link.brandReference !== brand ||
        link.storeReference !== store ||
        !evidenceValues.includes(paymentEvidence) ||
        closedAt < windowEndedAt
      )
        return fail();
      const identity = Object.freeze({
        orderReference: link.orderReference,
        orderBatchReference: link.orderBatchReference,
      });
      const allowed = async (tx: ConsumerTransaction) =>
        tx === transaction && (await options.authorize(tx, identity)) === true;
      if (!(await allowed(transaction))) return fail();
      // Same Order disposition fence as acceptance, payment outcome and termination.
      const sole = await createPostgresPickupOrderCompletionLookup({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx) => allowed(tx),
      }).loadByOrder({ transaction, orderReference: link.orderReference });
      if (
        sole === null ||
        sole.orderBatchReference !== link.orderBatchReference ||
        sole.submissionReference !== link.submissionReference ||
        !(await linked(transaction, link))
      )
        return fail();
      const operationReference = closureOperationReference(brand, store, link.orderReference);
      const terminal = await transaction.query(
        "SELECT operation_id::text AS operation,actor_type,reason_code,termination_id::text AS termination FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2",
        [brand, store, link.orderReference],
      );
      if (terminal.rows.length > 1) return fail();
      if (terminal.rows.length === 1) {
        const row = terminal.rows[0];
        if (
          row?.operation !== operationReference ||
          row.actor_type !== "System" ||
          row.reason_code !== pickupPaymentWindowClosurePolicy.reasonCode
        ) {
          if (!(await allowed(transaction))) return fail();
          return Object.freeze({ status: "NotEligible" as const, reason: "Terminated" as const });
        }
        const prior = await transaction.query(
          'SELECT termination_id AS "terminationReference",operation_id AS "operationReference",brand_id AS "brandReference",store_id AS "storeReference",order_id AS "orderReference",order_batch_id AS "orderBatchReference",expected_order_version AS "expectedOrderVersion",terminated_order_version AS "terminatedOrderVersion",expected_source_checkpoint AS "expectedSourceCheckpoint",previous_phase AS "previousPhase",phase,actor_type AS "actorType",actor_id AS "actorReference",purpose_code AS "purposeCode",permission_code AS "permissionCode",reason_code AS "reasonCode",workflow_version_id AS "workflowVersionReference",transition_id AS "transitionReference",source_digest AS "sourceDigest",terminated_at AS "terminatedAt" FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3',
          [brand, store, operationReference],
        );
        const original = prior.rows[0];
        const record = parseOrderTerminationRecord({
          ...original,
          terminatedAt:
            original?.terminatedAt instanceof Date
              ? original.terminatedAt.toISOString()
              : original?.terminatedAt,
        });
        if (
          prior.rows.length !== 1 ||
          record.orderReference !== link.orderReference ||
          record.orderBatchReference !== link.orderBatchReference ||
          record.phase !== "Cancelled" ||
          record.previousPhase !== "Submitted" ||
          !(await allowed(transaction))
        )
          return fail();
        return Object.freeze({ status: "AlreadyClosed" as const, record });
      }
      const execution = await createPostgresOrderInitialExecutionReader({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx) => allowed(tx),
      }).loadByBatch({
        transaction,
        orderReference: link.orderReference,
        orderBatchReference: link.orderBatchReference,
      });
      if (execution.phase !== "Submitted") {
        if (!(await allowed(transaction))) return fail();
        return Object.freeze({ status: "NotEligible" as const, reason: "Accepted" as const });
      }
      if (
        execution.version !== 1 ||
        execution.checkpoint !== link.submissionReference ||
        closedAt < execution.occurredAt
      )
        return fail();
      if (await paymentRecorded(transaction, link.orderReference)) {
        if (!(await allowed(transaction))) return fail();
        return Object.freeze({
          status: "NotEligible" as const,
          reason: "PaymentRecorded" as const,
        });
      }
      const policy = pickupPaymentWindowClosurePolicy;
      const record = parseOrderTerminationRecord({
        terminationReference,
        operationReference,
        brandReference: brand,
        storeReference: store,
        orderReference: link.orderReference,
        orderBatchReference: link.orderBatchReference,
        expectedOrderVersion: execution.version,
        terminatedOrderVersion: execution.version + 1,
        expectedSourceCheckpoint: execution.checkpoint,
        previousPhase: "Submitted",
        phase: "Cancelled",
        actorType: "System",
        actorReference: null,
        purposeCode: policy.purposeCode,
        permissionCode: policy.permissionCode,
        reasonCode: policy.reasonCode,
        workflowVersionReference: policy.workflowVersionReference,
        transitionReference: policy.transitionReference,
        sourceDigest: sha256({
          kind: "PickupPaymentWindowClosure/v1",
          link,
          windowEndedAt,
          paymentEvidence,
        }),
        terminatedAt: closedAt,
      });
      const result = await createPostgresOrderTerminationStore({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx, candidate) =>
          candidate.operationReference === operationReference && (await allowed(tx)),
        validateCurrentSource: async (tx, candidate) =>
          tx === transaction &&
          candidate.operationReference === operationReference &&
          (await linked(tx, link)) &&
          !(await paymentRecorded(tx, link.orderReference)),
        audit: async (candidate) => ({
          auditId: auditReference,
          brandId: brand,
          storeId: store,
          actor: { type: "System" },
          actionCode: "ORDER_TERMINATED",
          targetType: "Order",
          targetId: candidate.orderReference,
          correlationId: candidate.operationReference,
          reasonCode: candidate.reasonCode,
          occurredAt: candidate.terminatedAt,
          sourceChannel: "SYSTEM",
          afterSummary: { phase: candidate.phase },
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      }).commit({ transaction, record });
      if (result.status !== "Created" || !(await allowed(transaction))) return fail();
      return Object.freeze({ status: "Closed" as const, record: result.record });
    },
  });
}

/**
 * WP-2423 Q12: when the System closed this pickup Order because its payment window ended without
 * payment (customer status). Null for any other Order. Caller authorizes and owns the transaction.
 */
export async function loadPickupPaymentWindowClosure(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<{ readonly closedAt: string } | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(orderReference);
  await scoped(transaction, brand, store);
  const rows = (
    await transaction.query(
      "SELECT to_char(terminated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS closed_at FROM rms_ordering.order_termination_record " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND actor_type='System' AND phase='Cancelled' AND reason_code=$4 LIMIT 2",
      [brand, store, order, pickupPaymentWindowClosurePolicy.reasonCode],
    )
  ).rows;
  if (rows.length > 1) return fail();
  if (rows.length === 0) return null;
  return Object.freeze({ closedAt: parseOrderingInstant(rows[0]?.closed_at) });
}

/**
 * WP-2423 item 5 (Q1/Q9-G1): code-owned System policy that closes a paid pickup Order the Store did
 * not accept in time. Ordering already recorded the payment as PaidWithoutFulfillableOrder /
 * CapacityExpired (the acceptance window ended, or an outage hold expired) and Payment refunds it;
 * this ends the Order itself (Submitted → Cancelled), so it no longer reads as a live submitted
 * order anywhere. Like the payment window closure, the window is a fixed product rule, not a
 * Store-configurable workflow; its references identify this policy version in the history.
 */
export const paidAcceptanceLapseClosurePolicy = Object.freeze({
  reasonCode: "ACCEPTANCE_WINDOW_EXPIRED",
  purposeCode: "PaidOrderAcceptanceLapseClosure",
  permissionCode: "order.acceptance-window.close",
  workflowVersionReference: "019a0c00-2423-7012-8000-000000000003",
  transitionReference: "019a0c00-2423-7012-8000-000000000004",
} as const);

/** One closure operation per Order (retries and concurrent workers resolve to the same one). */
function lapseOperationReference(brand: string, store: string, order: string) {
  const h = createHash("sha256")
    .update(canonicalizeRfc8785(["PaidOrderAcceptanceLapseClosure/v1", brand, store, order]))
    .digest("hex");
  return parseOrderingReference(
    order.slice(0, 14) + "7" + h.slice(0, 3) + "-8" + h.slice(3, 6) + "-" + h.slice(6, 18),
  );
}

export type PaidAcceptanceLapseClosureResult = Readonly<
  | { status: "Closed" | "AlreadyClosed"; record: OrderTerminationRecord }
  /**
   * Not a pickup acceptance lapse (another disposition or reason, or a dine-in round), the Order
   * already ended another way, or it moved on (accepted).
   */
  | { status: "NotEligible"; reason: "NotAcceptanceLapse" | "Terminated" | "Accepted" }
>;

/**
 * Closes the pickup Order of a PaidWithoutFulfillableOrder / CapacityExpired disposition as
 * Cancelled by the System, bound to that disposition (append-only termination, revision and Audit;
 * no refund here — Payment's compensation owns that). The caller owns the transaction (roll back on
 * any thrown failure). Replay returns AlreadyClosed and writes nothing.
 */
export function createPostgresPaidAcceptanceLapseClosure(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    identity: Readonly<{ orderReference: string; orderBatchReference: string }>,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async close(
      transaction: ConsumerTransaction,
      value: unknown,
    ): Promise<PaidAcceptanceLapseClosureResult> {
      const raw = readClosedRecord(value, [
        "paymentEventReference",
        "closedAt",
        "terminationReference",
        "auditReference",
      ]);
      const paymentEventReference = parseOrderingReference(raw.paymentEventReference),
        closedAt = parseOrderingInstant(raw.closedAt),
        terminationReference = parseOrderingReference(raw.terminationReference),
        auditReference = parseOrderingReference(raw.auditReference);
      await scoped(transaction, brand, store);
      // The disposition is Ordering's own append-only record, re-read here; never the caller's copy.
      const found = await transaction.query(
        `SELECT d.disposition_id::text AS disposition,d.order_id::text AS "orderReference",
          d.order_batch_id::text AS "orderBatchReference",d.submission_id::text AS submission,
          d.source_digest AS digest,d.reason,h.order_type,
          to_char(d.evaluated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS evaluated
        FROM rms_ordering.order_payment_disposition_record d
        JOIN rms_ordering.order_header h ON h.brand_id=d.brand_id AND h.store_id=d.store_id AND h.order_id=d.order_id
        WHERE d.brand_id=$1 AND d.store_id=$2 AND d.payment_event_id=$3
          AND d.disposition='PaidWithoutFulfillableOrder' LIMIT 2`,
        [brand, store, paymentEventReference],
      );
      if (found.rows.length !== 1) return fail();
      const row = found.rows[0] ?? fail();
      const identity = Object.freeze({
        orderReference: parseOrderingReference(row.orderReference),
        orderBatchReference: parseOrderingReference(row.orderBatchReference),
      });
      const allowed = async (tx: ConsumerTransaction) =>
        tx === transaction && (await options.authorize(tx, identity)) === true;
      if (!(await allowed(transaction))) return fail();
      if (row.reason !== "CapacityExpired" || row.order_type !== "Pickup")
        return Object.freeze({
          status: "NotEligible" as const,
          reason: "NotAcceptanceLapse" as const,
        });
      const evaluatedAt = parseOrderingInstant(row.evaluated);
      if (closedAt < evaluatedAt) return fail();
      const sole = await createPostgresPickupOrderCompletionLookup({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx) => allowed(tx),
      }).loadByOrder({ transaction, orderReference: identity.orderReference });
      if (
        sole === null ||
        sole.orderBatchReference !== identity.orderBatchReference ||
        sole.submissionReference !== parseOrderingReference(row.submission)
      )
        return fail();
      const operationReference = lapseOperationReference(brand, store, identity.orderReference);
      const terminal = await transaction.query(
        "SELECT operation_id::text AS operation,termination_id::text AS termination FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2",
        [brand, store, identity.orderReference],
      );
      if (terminal.rows.length > 1) return fail();
      if (terminal.rows.length === 1) {
        if (terminal.rows[0]?.operation !== operationReference)
          return Object.freeze({ status: "NotEligible" as const, reason: "Terminated" as const });
        const prior = await transaction.query(
          'SELECT termination_id AS "terminationReference",operation_id AS "operationReference",brand_id AS "brandReference",store_id AS "storeReference",order_id AS "orderReference",order_batch_id AS "orderBatchReference",expected_order_version AS "expectedOrderVersion",terminated_order_version AS "terminatedOrderVersion",expected_source_checkpoint AS "expectedSourceCheckpoint",previous_phase AS "previousPhase",phase,actor_type AS "actorType",actor_id AS "actorReference",purpose_code AS "purposeCode",permission_code AS "permissionCode",reason_code AS "reasonCode",workflow_version_id AS "workflowVersionReference",transition_id AS "transitionReference",source_digest AS "sourceDigest",terminated_at AS "terminatedAt" FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3',
          [brand, store, operationReference],
        );
        const original = prior.rows[0];
        const record = parseOrderTerminationRecord({
          ...original,
          terminatedAt:
            original?.terminatedAt instanceof Date
              ? original.terminatedAt.toISOString()
              : original?.terminatedAt,
        });
        if (
          prior.rows.length !== 1 ||
          record.reasonCode !== paidAcceptanceLapseClosurePolicy.reasonCode ||
          record.actorType !== "System" ||
          !(await allowed(transaction))
        )
          return fail();
        return Object.freeze({ status: "AlreadyClosed" as const, record });
      }
      const execution = await createPostgresOrderInitialExecutionReader({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx) => allowed(tx),
      }).loadByBatch({ transaction, ...identity });
      if (execution.phase !== "Submitted")
        return Object.freeze({ status: "NotEligible" as const, reason: "Accepted" as const });
      if (closedAt < execution.occurredAt) return fail();
      const policy = paidAcceptanceLapseClosurePolicy;
      const record = parseOrderTerminationRecord({
        terminationReference,
        operationReference,
        brandReference: brand,
        storeReference: store,
        orderReference: identity.orderReference,
        orderBatchReference: identity.orderBatchReference,
        expectedOrderVersion: execution.version,
        terminatedOrderVersion: execution.version + 1,
        expectedSourceCheckpoint: execution.checkpoint,
        previousPhase: "Submitted",
        phase: "Cancelled",
        actorType: "System",
        actorReference: null,
        purposeCode: policy.purposeCode,
        permissionCode: policy.permissionCode,
        reasonCode: policy.reasonCode,
        workflowVersionReference: policy.workflowVersionReference,
        transitionReference: policy.transitionReference,
        sourceDigest: sha256({
          kind: "PaidOrderAcceptanceLapseClosure/v1",
          dispositionReference: row.disposition,
          dispositionDigest: row.digest,
          paymentEventReference,
        }),
        terminatedAt: closedAt,
      });
      const result = await createPostgresOrderTerminationStore({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx, candidate) =>
          candidate.operationReference === operationReference && (await allowed(tx)),
        validateCurrentSource: async (tx, candidate) =>
          tx === transaction && candidate.operationReference === operationReference,
        audit: async (candidate) => ({
          auditId: auditReference,
          brandId: brand,
          storeId: store,
          actor: { type: "System" },
          actionCode: "ORDER_TERMINATED",
          targetType: "Order",
          targetId: candidate.orderReference,
          correlationId: candidate.operationReference,
          reasonCode: candidate.reasonCode,
          occurredAt: candidate.terminatedAt,
          sourceChannel: "SYSTEM",
          afterSummary: { phase: candidate.phase },
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      }).commit({ transaction, record });
      if (result.status !== "Created" || !(await allowed(transaction))) return fail();
      return Object.freeze({ status: "Closed" as const, record: result.record });
    },
  });
}
