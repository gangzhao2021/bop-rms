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
 *
 * DEC-PAPER-ORDER-NEVER-RELEASED: a paper order (a counter order staff entered after an outage) is
 * a sale that already happened, so it is never a candidate: it stays open, its stock stays set
 * aside and staff see it until its payment is recorded or it is re-entered from the paper slip.
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
            AND NOT EXISTS (SELECT 1 FROM rms_ordering.counter_order_entry e
              WHERE e.brand_id=b.brand_id AND e.store_id=b.store_id AND e.cart_id=b.source_cart_id
                AND e.recorded_after_outage)
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
  /**
   * Accepted/terminated otherwise, or a payment is recorded: the paid-outcome path owns it. A paper
   * order is never closed (DEC-PAPER-ORDER-NEVER-RELEASED).
   */
  | {
      status: "NotEligible";
      reason: "Accepted" | "Terminated" | "PaymentRecorded" | "PaperOrder";
    }
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
  const paperOrder = async (tx: ConsumerTransaction, link: OrderCapacityLink) => {
    const result = await tx.query(
      `SELECT e.recorded_after_outage AS paper FROM rms_ordering.order_batch b
      JOIN rms_ordering.counter_order_entry e ON e.brand_id=b.brand_id AND e.store_id=b.store_id
        AND e.cart_id=b.source_cart_id
      WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4 LIMIT 2`,
      [brand, store, link.orderReference, link.orderBatchReference],
    );
    if (result.rows.length > 1) return fail();
    const paper = result.rows[0]?.paper;
    if (result.rows.length === 1 && typeof paper !== "boolean") return fail();
    return paper === true;
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
      // DEC-PAPER-ORDER-NEVER-RELEASED: re-checked here, under the closure's own fences, whatever
      // the scan said: a sale taken on paper during an outage is never released by its window.
      if (await paperOrder(transaction, link)) {
        if (!(await allowed(transaction))) return fail();
        return Object.freeze({ status: "NotEligible" as const, reason: "PaperOrder" as const });
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
          !(await paymentRecorded(tx, link.orderReference)) &&
          !(await paperOrder(tx, link)),
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

/**
 * WP-2423 M127: staff cancel a counter order nobody paid for (the guest changed their mind, it was
 * entered by mistake, or the guest left without paying), before its payment window ends, so its
 * items go back to stock at once. Recorded as a User termination naming the staff member and the
 * reason; never a hidden or deleted sale. Kept with the managers who may cancel orders
 * (`ordering.order.cancel`, as for an unpaid table round). A paper order entered after an outage
 * is a sale that already happened: it is recorded and paid, never cancelled here.
 */
export const counterUnpaidCancellationPolicy = Object.freeze({
  purposeCode: "CounterUnpaidCancellation",
  permissionCode: "ordering.order.cancel",
  workflowVersionReference: "019a0c00-2423-7490-8000-000000000001",
  transitionReference: "019a0c00-2423-7490-8000-000000000002",
} as const);
export const counterUnpaidCancellationReasons = [
  "COUNTER_GUEST_CHANGED_MIND",
  "COUNTER_ENTERED_WRONG",
  "COUNTER_GUEST_LEFT_UNPAID",
  /**
   * DEC-PAPER-ORDER-NEVER-RELEASED: a paper order whose payment could not be recorded before its
   * payment window ended was entered again from its paper slip as a new paper order whose payment
   * is recorded. Only that reason ends a paper order, and only naming the new order (once each).
   */
  "COUNTER_PAPER_REENTERED",
] as const;
export type CounterUnpaidCancellationReason = (typeof counterUnpaidCancellationReasons)[number];
export type CounterUnpaidCancellationResult = Readonly<
  | { status: "Cancelled" | "AlreadyCancelled"; record: OrderTerminationRecord }
  | {
      status: "NotEligible";
      reason:
        | "NotCounter"
        | "PaperOrder"
        | "Accepted"
        | "Terminated"
        | "PaymentRecorded"
        | "VersionConflict"
        /** COUNTER_PAPER_REENTERED for an order that is not a paper order. */
        | "NotPaperOrder"
        /**
         * The re-entered order is not a paper counter order of this Store sent after this one and
         * still open, or it is this order.
         */
        | "ReentryInvalid"
        /** The re-entered order already stands for another paper order. */
        | "ReentryUsed"
        /**
         * The re-entered order's sale (dishes with tax, before tip) is lower than this paper order's:
         * linking it would take the difference out of the books.
         */
        | "ReentryAmountLower";
    }
>;

/** One re-entry per new order: the same new order can never close two paper orders. */
function paperReentryOperationReference(brand: string, store: string, reentered: string) {
  const h = createHash("sha256")
    .update(canonicalizeRfc8785(["CounterPaperReentry/v1", brand, store, reentered]))
    .digest("hex");
  return parseOrderingReference(
    reentered.slice(0, 14) + "7" + h.slice(0, 3) + "-8" + h.slice(3, 6) + "-" + h.slice(6, 18),
  );
}

/**
 * DEC-PAPER-ORDER-NEVER-RELEASED: the batch of a counter order, whether it was entered from paper,
 * when it was sent, whether it has ended, its order number and its sale (the quote total: dishes
 * with tax, before tip; null without a quote). Null when the Order is not a counter order of this
 * Store. Caller authorizes and owns the transaction.
 */
export async function loadCounterOrderBatch(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<{
  readonly orderBatchReference: string;
  readonly recordedAfterOutage: boolean;
  readonly submittedAt: string;
  readonly ended: boolean;
  readonly orderNumber: string;
  readonly sale: { readonly amountMinor: bigint; readonly currencyCode: string } | null;
} | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(orderReference);
  await scoped(transaction, brand, store);
  const found = await transaction.query(
    `SELECT b.order_batch_id::text AS batch,e.recorded_after_outage AS paper,
      to_char(b.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted,
      EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t
        WHERE t.brand_id=b.brand_id AND t.store_id=b.store_id AND t.order_id=b.order_id) AS ended,
      h.order_number AS number,q.total_minor::text AS sale,q.currency_code AS currency
    FROM rms_ordering.order_batch b
    JOIN rms_ordering.order_header h ON h.brand_id=b.brand_id AND h.store_id=b.store_id
      AND h.order_id=b.order_id
    JOIN rms_ordering.counter_order_entry e ON e.brand_id=b.brand_id AND e.store_id=b.store_id
      AND e.cart_id=b.source_cart_id
    LEFT JOIN rms_ordering.cart_quote_attachment q ON q.brand_id=b.brand_id
      AND q.store_id=b.store_id AND q.quote_id=b.quote_id
    WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 LIMIT 2`,
    [brand, store, order],
  );
  if (found.rows.length > 1) return fail();
  const row = found.rows[0];
  if (row === undefined) return null;
  if (
    typeof row.paper !== "boolean" ||
    typeof row.ended !== "boolean" ||
    typeof row.number !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(row.number) ||
    (row.sale !== null &&
      (typeof row.sale !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(row.sale))) ||
    (row.sale !== null && (typeof row.currency !== "string" || !/^[A-Z]{3}$/u.test(row.currency)))
  )
    return fail();
  return Object.freeze({
    orderBatchReference: String(parseOrderingReference(row.batch)),
    recordedAfterOutage: row.paper,
    submittedAt: parseOrderingInstant(row.submitted),
    ended: row.ended,
    orderNumber: row.number,
    sale:
      row.sale === null
        ? null
        : Object.freeze({ amountMinor: BigInt(row.sale), currencyCode: String(row.currency) }),
  });
}

/**
 * DEC-PAPER-ORDER-NEVER-RELEASED: the paper counter orders of this Store that may stand for paper
 * order `orderReference` once it was entered again from its slip: sent no earlier than it, still
 * open and not standing for another paper order yet, newest first, at most `limit` (whatever
 * business day they belong to). Whether their payment is recorded is Payment's fact (the caller
 * asks it). Caller authorizes and owns the transaction.
 */
export async function listPaperReentryCandidates(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
  limit = 20,
): Promise<
  readonly {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly orderNumber: string;
    readonly submittedAt: string;
    readonly sale: { readonly amountMinor: bigint; readonly currencyCode: string } | null;
  }[]
> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(orderReference);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return fail();
  await scoped(transaction, brand, store);
  const found = await transaction.query(
    `SELECT b.order_id::text AS order_id,b.order_batch_id::text AS batch,h.order_number AS number,
      to_char(b.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted,
      q.total_minor::text AS sale,q.currency_code AS currency
    FROM rms_ordering.order_batch mine
    JOIN rms_ordering.order_batch b ON b.brand_id=mine.brand_id AND b.store_id=mine.store_id
      AND b.order_id<>mine.order_id AND b.submitted_at>=mine.submitted_at
    JOIN rms_ordering.order_header h ON h.brand_id=b.brand_id AND h.store_id=b.store_id
      AND h.order_id=b.order_id
    JOIN rms_ordering.counter_order_entry e ON e.brand_id=b.brand_id AND e.store_id=b.store_id
      AND e.cart_id=b.source_cart_id AND e.recorded_after_outage
    LEFT JOIN rms_ordering.cart_quote_attachment q ON q.brand_id=b.brand_id
      AND q.store_id=b.store_id AND q.quote_id=b.quote_id
    WHERE mine.brand_id=$1 AND mine.store_id=$2 AND mine.order_id=$3
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t
        WHERE t.brand_id=b.brand_id AND t.store_id=b.store_id AND t.order_id=b.order_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.counter_paper_reentry r
        WHERE r.brand_id=b.brand_id AND r.store_id=b.store_id AND r.reentered_order_id=b.order_id)
    ORDER BY b.submitted_at DESC,b.order_id DESC LIMIT $4`,
    [brand, store, order, limit],
  );
  return found.rows.map((row) => {
    if (
      typeof row.number !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(row.number) ||
      (row.sale !== null &&
        (typeof row.sale !== "string" ||
          !/^(0|[1-9][0-9]{0,18})$/u.test(row.sale) ||
          typeof row.currency !== "string" ||
          !/^[A-Z]{3}$/u.test(row.currency)))
    )
      return fail();
    return Object.freeze({
      orderReference: String(parseOrderingReference(row.order_id)),
      orderBatchReference: String(parseOrderingReference(row.batch)),
      orderNumber: row.number,
      submittedAt: parseOrderingInstant(row.submitted),
      sale:
        row.sale === null
          ? null
          : Object.freeze({ amountMinor: BigInt(row.sale), currencyCode: String(row.currency) }),
    });
  });
}

/**
 * The counter Order's capacity link (the Payment operation and submission it was placed with), so
 * the caller can take Payment's and Fulfillment's fences before cancelling. Null when the Order is
 * not a counter order of this Store. Caller authorizes and owns the transaction.
 */
export async function loadCounterOrderCapacityLink(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  identity: { readonly orderReference: string; readonly orderBatchReference: string },
): Promise<{ readonly link: OrderCapacityLink; readonly recordedAfterOutage: boolean } | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(identity.orderReference),
    batch = parseOrderingReference(identity.orderBatchReference);
  await scoped(transaction, brand, store);
  const found = await transaction.query(
    `SELECT l.link_json AS link,e.recorded_after_outage AS paper
    FROM rms_ordering.order_batch b
    JOIN rms_ordering.counter_order_entry e ON e.brand_id=b.brand_id AND e.store_id=b.store_id
      AND e.cart_id=b.source_cart_id
    JOIN rms_ordering.order_capacity_link l ON l.brand_id=b.brand_id AND l.store_id=b.store_id
      AND l.order_id=b.order_id AND l.order_batch_id=b.order_batch_id AND l.submission_id=b.submission_id
    WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4 LIMIT 2`,
    [brand, store, order, batch],
  );
  if (found.rows.length > 1) return fail();
  const row = found.rows[0];
  if (row === undefined) return null;
  const link = parseOrderCapacityLink(row.link);
  if (
    link.owner !== "Fulfillment" ||
    link.brandReference !== brand ||
    link.storeReference !== store ||
    link.orderReference !== order ||
    link.orderBatchReference !== batch ||
    typeof row.paper !== "boolean"
  )
    return fail();
  return Object.freeze({ link, recordedAfterOutage: row.paper });
}

/**
 * Cancels one unpaid counter Order for a staff member (append-only termination with Audit naming
 * them). The caller holds Payment's operation fence, has proved from Payment that nothing was
 * recorded or charged, and owns the transaction (roll back on any thrown failure). The same
 * operation again returns AlreadyCancelled and writes nothing.
 */
export function createPostgresCounterUnpaidCancellation(options: {
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
    async cancel(
      transaction: ConsumerTransaction,
      value: unknown,
    ): Promise<CounterUnpaidCancellationResult> {
      const reentry =
        value !== null &&
        typeof value === "object" &&
        (value as { reasonCode?: unknown }).reasonCode === "COUNTER_PAPER_REENTERED";
      const raw = readClosedRecord(value, [
        "orderReference",
        "orderBatchReference",
        "operationReference",
        "expectedOrderVersion",
        "actorReference",
        "reasonCode",
        "cancelledAt",
        "terminationReference",
        "auditReference",
        // DEC-PAPER-ORDER-NEVER-RELEASED: the new paper order this one was entered again as.
        ...(reentry ? ["reenteredOrderReference"] : []),
      ]);
      const identity = Object.freeze({
        orderReference: parseOrderingReference(raw.orderReference),
        orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      });
      const reenteredOrderReference = reentry
        ? parseOrderingReference(raw.reenteredOrderReference)
        : null;
      // A re-entry's operation is the new order's own (UNIQUE per Store), so one new order closes
      // at most one paper order, whatever reference the caller sent.
      const operationReference =
          reenteredOrderReference === null
            ? parseOrderingReference(raw.operationReference)
            : paperReentryOperationReference(brand, store, reenteredOrderReference),
        actorReference = parseOrderingReference(raw.actorReference),
        cancelledAt = parseOrderingInstant(raw.cancelledAt),
        terminationReference = parseOrderingReference(raw.terminationReference),
        auditReference = parseOrderingReference(raw.auditReference);
      const reasonCode = counterUnpaidCancellationReasons.find((code) => code === raw.reasonCode);
      if (
        reasonCode === undefined ||
        typeof raw.expectedOrderVersion !== "number" ||
        !Number.isSafeInteger(raw.expectedOrderVersion) ||
        raw.expectedOrderVersion < 1
      )
        return fail();
      const allowed = async (tx: ConsumerTransaction) =>
        tx === transaction && (await options.authorize(tx, identity)) === true;
      const answer = async (result: CounterUnpaidCancellationResult) => {
        if (!(await allowed(transaction))) return fail();
        return Object.freeze(result);
      };
      if (!(await allowed(transaction))) return fail();
      const counter = await loadCounterOrderCapacityLink(
        transaction,
        { brandReference: brand, storeReference: store },
        identity,
      );
      if (counter === null) return answer({ status: "NotEligible", reason: "NotCounter" });
      // A paper order is a sale that happened during the outage: recorded and paid, never cancelled
      // — only closed as entered again, naming the new paper order whose payment is recorded.
      if (counter.recordedAfterOutage && reenteredOrderReference === null)
        return answer({ status: "NotEligible", reason: "PaperOrder" });
      if (!counter.recordedAfterOutage && reenteredOrderReference !== null)
        return answer({ status: "NotEligible", reason: "NotPaperOrder" });
      // The link written with the termination: which new order carries the sale, at what amounts.
      let reentryLink: {
        readonly reenteredOrderReference: string;
        readonly reenteredOrderNumber: string;
        readonly paperSaleMinor: bigint;
        readonly reenteredSaleMinor: bigint;
        readonly currencyCode: string;
      } | null = null;
      if (reenteredOrderReference !== null) {
        if (reenteredOrderReference === identity.orderReference)
          return answer({ status: "NotEligible", reason: "ReentryInvalid" });
        const used = await transaction.query(
          "SELECT order_id::text AS order_id FROM rms_ordering.counter_paper_reentry WHERE brand_id=$1 AND store_id=$2 AND reentered_order_id=$3 LIMIT 2",
          [brand, store, reenteredOrderReference],
        );
        if (used.rows.length > 1) return fail();
        if (used.rows.length === 1 && used.rows[0]?.order_id !== identity.orderReference)
          return answer({ status: "NotEligible", reason: "ReentryUsed" });
        const owner = { brandReference: brand, storeReference: store };
        const mine = await loadCounterOrderBatch(transaction, owner, identity.orderReference);
        const reentered = await loadCounterOrderBatch(transaction, owner, reenteredOrderReference);
        if (mine === null) return fail();
        if (
          reentered === null ||
          !reentered.recordedAfterOutage ||
          (used.rows.length === 0 && reentered.ended) ||
          reentered.submittedAt < mine.submittedAt ||
          mine.sale === null ||
          reentered.sale === null ||
          reentered.sale.currencyCode !== mine.sale.currencyCode
        )
          return answer({ status: "NotEligible", reason: "ReentryInvalid" });
        // A sale is never closed by a cheaper order: the new order carries at least the paper
        // order's dishes with tax, to the cent.
        if (reentered.sale.amountMinor < mine.sale.amountMinor)
          return answer({ status: "NotEligible", reason: "ReentryAmountLower" });
        reentryLink = Object.freeze({
          reenteredOrderReference,
          reenteredOrderNumber: reentered.orderNumber,
          paperSaleMinor: mine.sale.amountMinor,
          reenteredSaleMinor: reentered.sale.amountMinor,
          currencyCode: mine.sale.currencyCode,
        });
      }
      const link = counter.link;
      // Same Order disposition fence as acceptance, payment outcome and termination.
      const sole = await createPostgresPickupOrderCompletionLookup({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx) => allowed(tx),
      }).loadByOrder({ transaction, orderReference: identity.orderReference });
      if (
        sole === null ||
        sole.orderBatchReference !== identity.orderBatchReference ||
        sole.submissionReference !== link.submissionReference
      )
        return fail();
      const terminal = await transaction.query(
        "SELECT operation_id::text AS operation FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2",
        [brand, store, identity.orderReference],
      );
      if (terminal.rows.length > 1) return fail();
      if (terminal.rows.length === 1) {
        if (terminal.rows[0]?.operation !== operationReference)
          return answer({ status: "NotEligible", reason: "Terminated" });
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
        // The same staff member's retry of their own cancellation answers with what was recorded
        // (its first reason), even when they picked another reason before retrying a lost answer.
        // A re-entry is the new order's own operation: any manager linking the same new order
        // again is told it is already done.
        if (
          prior.rows.length !== 1 ||
          record.actorType !== "User" ||
          (reenteredOrderReference === null && record.actorReference !== actorReference) ||
          record.purposeCode !== counterUnpaidCancellationPolicy.purposeCode
        )
          return fail();
        return answer({ status: "AlreadyCancelled", record });
      }
      const execution = await createPostgresOrderInitialExecutionReader({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx) => allowed(tx),
      }).loadByBatch({ transaction, ...identity });
      if (execution.phase !== "Submitted")
        return answer({ status: "NotEligible", reason: "Accepted" });
      if (execution.version !== raw.expectedOrderVersion)
        return answer({ status: "NotEligible", reason: "VersionConflict" });
      if (execution.checkpoint !== link.submissionReference || cancelledAt < execution.occurredAt)
        return fail();
      const paymentRecorded = async (tx: ConsumerTransaction) => {
        const result = await tx.query(
          "SELECT (SELECT count(*)::int FROM rms_ordering.order_payment_acceptance_wait WHERE brand_id=$1 AND store_id=$2 AND order_id=$3)+" +
            "(SELECT count(*)::int FROM rms_ordering.order_payment_disposition_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) AS n",
          [brand, store, identity.orderReference],
        );
        const n = result.rows[0]?.n;
        if (result.rows.length !== 1 || typeof n !== "number") return fail();
        return n !== 0;
      };
      if (await paymentRecorded(transaction))
        return answer({ status: "NotEligible", reason: "PaymentRecorded" });
      const policy = counterUnpaidCancellationPolicy;
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
        actorType: "User",
        actorReference,
        purposeCode: policy.purposeCode,
        permissionCode: policy.permissionCode,
        reasonCode,
        workflowVersionReference: policy.workflowVersionReference,
        transitionReference: policy.transitionReference,
        sourceDigest: sha256(
          reenteredOrderReference === null
            ? { kind: "CounterUnpaidCancellation/v1", link, reasonCode }
            : { kind: "CounterPaperReentry/v1", link, reasonCode, reenteredOrderReference },
        ),
        terminatedAt: cancelledAt,
      });
      if (reentryLink !== null) {
        // The new order is claimed first: a second manager linking the same new order to another
        // paper order at the same moment waits here for the first, then is told it is taken
        // (never "no answer"), and nothing of theirs is written.
        const claimed = await transaction.query(
          "INSERT INTO rms_ordering.counter_paper_reentry (brand_id,store_id,order_id,reentered_order_id,termination_id,paper_sale_minor,reentered_sale_minor,currency_code,actor_id,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING order_id::text AS order_id",
          [
            brand,
            store,
            identity.orderReference,
            reentryLink.reenteredOrderReference,
            terminationReference,
            reentryLink.paperSaleMinor.toString(),
            reentryLink.reenteredSaleMinor.toString(),
            reentryLink.currencyCode,
            actorReference,
            cancelledAt,
          ],
        );
        if (claimed.rows.length !== 1) {
          const taken = await transaction.query(
            "SELECT order_id::text AS order_id FROM rms_ordering.counter_paper_reentry WHERE brand_id=$1 AND store_id=$2 AND reentered_order_id=$3 LIMIT 2",
            [brand, store, reentryLink.reenteredOrderReference],
          );
          if (taken.rows.length === 1 && taken.rows[0]?.order_id !== identity.orderReference)
            return answer({ status: "NotEligible", reason: "ReentryUsed" });
          // This paper order was closed by someone else meanwhile.
          return answer({ status: "NotEligible", reason: "Terminated" });
        }
      }
      const result = await createPostgresOrderTerminationStore({
        brandReference: brand,
        storeReference: store,
        authorize: async (tx, candidate) =>
          candidate.operationReference === operationReference && (await allowed(tx)),
        validateCurrentSource: async (tx, candidate) =>
          tx === transaction &&
          candidate.operationReference === operationReference &&
          !(await paymentRecorded(tx)),
        audit: async (candidate) => ({
          auditId: auditReference,
          brandId: brand,
          storeId: store,
          actor: { type: "User", reference: actorReference },
          actionCode: "ORDER_TERMINATED",
          targetType: "Order",
          targetId: candidate.orderReference,
          correlationId: candidate.operationReference,
          reasonCode: candidate.reasonCode,
          occurredAt: candidate.terminatedAt,
          sourceChannel: "MERCHANT_WEB",
          // The termination's own Audit summary is fixed ({phase}); which new order now carries the
          // sale is the counter_paper_reentry record written in the same transaction.
          afterSummary: { phase: candidate.phase },
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      }).commit({ transaction, record });
      if (result.status !== "Created" || !(await allowed(transaction))) return fail();
      return Object.freeze({ status: "Cancelled" as const, record: result.record });
    },
  });
}

/**
 * WP-2423 M127: the counter orders of these Orders that staff cancelled before payment, with the
 * reason and when (for Orders: "Cancelled before payment · Guest changed their mind"). Caller
 * authorizes and owns the transaction.
 */
export async function listCounterUnpaidCancellations(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly reasonCode: CounterUnpaidCancellationReason;
      readonly cancelledAt: string;
      /** WP-2423 M61: the staff member who cancelled (for the order's record; never shown as is). */
      readonly actorReference: string;
      /**
       * DEC-PAPER-ORDER-NEVER-RELEASED: a paper order closed as entered again names the new order
       * now carrying its sale (its number for staff), else null.
       */
      readonly reentered: { readonly orderReference: string; readonly orderNumber: string } | null;
    }
  >
> {
  const result = new Map<
    string,
    {
      readonly reasonCode: CounterUnpaidCancellationReason;
      readonly cancelledAt: string;
      /** WP-2423 M61: the staff member who cancelled (for the order's record; never shown as is). */
      readonly actorReference: string;
      /**
       * DEC-PAPER-ORDER-NEVER-RELEASED: a paper order closed as entered again names the new order
       * now carrying its sale (its number for staff), else null.
       */
      readonly reentered: { readonly orderReference: string; readonly orderNumber: string } | null;
    }
  >();
  if (orderReferences.length === 0) return result;
  if (orderReferences.length > 500) return fail();
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    orders = orderReferences.map((value) => parseOrderingReference(value));
  await scoped(transaction, brand, store);
  const found = await transaction.query(
    "SELECT t.order_id::text AS order_id,t.reason_code,t.actor_id::text AS actor_id,to_char(t.terminated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at," +
      "r.reentered_order_id::text AS reentered,h.order_number AS reentered_number FROM rms_ordering.order_termination_record t " +
      "LEFT JOIN rms_ordering.counter_paper_reentry r ON r.brand_id=t.brand_id AND r.store_id=t.store_id AND r.termination_id=t.termination_id " +
      "LEFT JOIN rms_ordering.order_header h ON h.brand_id=r.brand_id AND h.store_id=r.store_id AND h.order_id=r.reentered_order_id " +
      "WHERE t.brand_id=$1 AND t.store_id=$2 AND t.order_id=ANY($3::uuid[]) AND t.actor_type='User' AND t.purpose_code=$4",
    [brand, store, orders, counterUnpaidCancellationPolicy.purposeCode],
  );
  for (const row of found.rows) {
    const reasonCode = counterUnpaidCancellationReasons.find((code) => code === row.reason_code);
    if (reasonCode === undefined || row.actor_id === null) return fail();
    // A paper order closed as entered again always has its link (written in the same transaction).
    if ((reasonCode === "COUNTER_PAPER_REENTERED") !== (row.reentered !== null)) return fail();
    if (row.reentered !== null && typeof row.reentered_number !== "string") return fail();
    result.set(String(parseOrderingReference(row.order_id)), {
      reasonCode,
      cancelledAt: parseOrderingInstant(row.at),
      actorReference: String(parseOrderingReference(row.actor_id)),
      reentered:
        row.reentered === null
          ? null
          : Object.freeze({
              orderReference: String(parseOrderingReference(row.reentered)),
              orderNumber: String(row.reentered_number),
            }),
    });
  }
  return result;
}
