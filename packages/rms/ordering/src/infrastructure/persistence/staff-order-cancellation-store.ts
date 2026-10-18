import { createHash } from "node:crypto";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import type { OrderPaymentOutcomeDisposition } from "../../contracts/order-payment-outcome.js";
import { parseOrderTerminationRecord } from "../../application/order-termination-record.js";
import {
  parseStaffOrderCancellationPlan,
  parseStaffOrderCancellationReasonCode,
  parseStaffOrderCancellationRecord,
  staffOrderCancellationDisposition,
  staffOrderCancellationPolicy,
  StaffOrderCancellationError,
  type StaffOrderCancellationPlan,
  type StaffOrderCancellationRecord,
  type StaffOrderCancellationRefundDisposition,
} from "../../application/staff-order-cancellation.js";
import { createPostgresOrderTerminationStore } from "./order-termination-store.js";

const columns = {
  cancellationReference: "cancellation_id",
  operationReference: "operation_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  orderBatchReference: "order_batch_id",
  submissionReference: "submission_id",
  orderType: "order_type",
  expectedOrderVersion: "expected_order_version",
  cancelledOrderVersion: "cancelled_order_version",
  expectedSourceCheckpoint: "expected_source_checkpoint",
  actorReference: "actor_id",
  reasonCode: "reason_code",
  paymentDispositionReference: "payment_disposition_id",
  paymentTransactionReference: "payment_transaction_id",
  paymentIntentReference: "payment_intent_id",
  paymentAttemptReference: "payment_attempt_id",
  paymentEventReference: "payment_event_id",
  orderItemReferences: "order_item_ids",
  kitchenEvidenceDigest: "kitchen_evidence_digest",
  sourceDigest: "source_digest",
  auditReference: "audit_id",
  cancelledAt: "cancelled_at",
  previousPhase: "previous_phase",
  refundDisposition: "refund_disposition",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[];
const selection = keys
  .map((key) =>
    key === "cancelledAt"
      ? 'to_char(cancelled_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "cancelledAt"'
      : key === "orderItemReferences"
        ? 'order_item_ids::text[] AS "orderItemReferences"'
        : columns[key] + ' AS "' + key + '"',
  )
  .join(",");
const conflict = (): never => {
  throw new StaffOrderCancellationError("STAFF_ORDER_CANCELLATION_CONFLICT");
};
const unavailable = (): never => {
  throw new StaffOrderCancellationError("STAFF_ORDER_CANCELLATION_UNAVAILABLE");
};
const sha256 = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
const instant = (value: unknown) =>
  parseOrderingInstant(value instanceof Date ? value.toISOString() : value);

type Scope = Readonly<{ brandReference: string; storeReference: string }>;
async function setScope(tx: ConsumerTransaction, scope: Scope) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
}
/** Same Order disposition fence as acceptance, payment outcome, termination and batch writers. */
async function fence(tx: ConsumerTransaction, scope: Scope, orderReference: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "OrderingOrderDisposition:" +
      scope.brandReference +
      ":" +
      scope.storeReference +
      ":" +
      orderReference,
  ]);
}
function bind(row: Record<string, unknown> | undefined) {
  if (!row) return unavailable();
  return parseStaffOrderCancellationRecord({ ...row });
}

/**
 * Staff cancellations of the given Orders (at most 100), in cancellation order. Caller authorizes
 * and owns the transaction; any Batch has at most one.
 */
export async function readStaffOrderCancellations(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<readonly StaffOrderCancellationRecord[]> {
  if (orderReferences.length === 0) return Object.freeze([]);
  if (orderReferences.length > 100) return unavailable();
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  await setScope(tx, { brandReference: brand, storeReference: store });
  const found = await tx.query(
    "SELECT " +
      selection +
      " FROM rms_ordering.order_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) ORDER BY cancellation_id LIMIT 10001",
    [brand, store, orders],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 10000) return unavailable();
  const batches = new Set<string>();
  return Object.freeze(
    found.rows.map((row) => {
      const record = bind(row);
      if (
        record.brandReference !== brand ||
        record.storeReference !== store ||
        !orders.includes(record.orderReference as never) ||
        batches.has(record.orderBatchReference)
      )
        return unavailable();
      batches.add(record.orderBatchReference);
      return record;
    }),
  );
}

export type StaffOrderCancellationNotEligibleReason =
  "NotFound" | "VersionConflict" | "NotConfirmed" | "AlreadyCancelled" | "Completed" | "Closed";

/** Payment facts of the waiting (never accepted) disposition, from its JSON record. */
function waitingPayment(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const record = value as Record<string, unknown>;
  if (record.disposition !== "AwaitingAcceptance") return unavailable();
  return {
    dispositionReference: parseOrderingReference(record.dispositionReference),
    paymentTransactionReference: parseOrderingReference(record.paymentTransactionReference),
    paymentIntentReference: parseOrderingReference(record.paymentIntentReference),
    paymentAttemptReference: parseOrderingReference(record.paymentAttemptReference),
    paymentEventReference: parseOrderingReference(record.paymentEventReference),
  };
}
export type StaffOrderCancellationPreparation = Readonly<
  | { status: "Ready"; plan: StaffOrderCancellationPlan }
  | { status: "NotEligible"; reason: StaffOrderCancellationNotEligibleReason }
>;

/**
 * WP-2423 Q6: store staff cancel a paid (captured, Confirmed) and accepted Batch before the
 * kitchen starts it. Pickup: the sole Batch, so the whole Order is terminated as Cancelled by the
 * User (Ordering termination + its Audit) and the staff record binds to that termination. Dine-in:
 * only the Batch is cancelled (StaffBatchCancellation revision); the Order stays open.
 * The caller composes Kitchen, Inventory and Payment in the same transaction and owns
 * commit/rollback; any thrown failure must roll the whole command back.
 */
export function createPostgresStaffOrderCancellationStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    identity: Readonly<{
      orderReference: string;
      orderBatchReference: string;
      actorReference: string;
    }>,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  });
  const { brandReference: brand, storeReference: store } = scope;
  const allowed = async (
    tx: ConsumerTransaction,
    identity: { orderReference: string; orderBatchReference: string; actorReference: string },
  ) => {
    if ((await options.authorize(tx, Object.freeze({ ...identity }))) !== true) unavailable();
  };
  const single = async (tx: ConsumerTransaction, sql: string, values: readonly unknown[]) => {
    const rows = (await tx.query(sql, values)).rows;
    if (rows.length > 1) return unavailable();
    return rows[0];
  };

  /** Current eligibility under the retained Order fence and Order row lock. */
  async function evaluate(
    tx: ConsumerTransaction,
    order: string,
    batch: string,
    expectedOrderVersion: number,
  ): Promise<
    | { status: "Ready"; plan: StaffOrderCancellationPlan; occurredAt: string }
    | { status: "NotEligible"; reason: StaffOrderCancellationNotEligibleReason }
  > {
    const notEligible = (reason: StaffOrderCancellationNotEligibleReason) =>
      ({ status: "NotEligible", reason }) as const;
    const header = await single(
      tx,
      "SELECT order_type FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
      [brand, store, order],
    );
    if (!header) return notEligible("NotFound");
    const orderType = header.order_type;
    if (orderType !== "Pickup" && orderType !== "DineIn") return unavailable();
    const batches = (
      await tx.query(
        "SELECT order_batch_id::text AS batch,submission_id::text AS submission FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY order_batch_id LIMIT 10002 FOR SHARE",
        [brand, store, order],
      )
    ).rows;
    const target = batches.find((row) => row.batch === batch);
    if (!target) return notEligible("NotFound");
    if (orderType === "Pickup" && batches.length !== 1) return unavailable();
    const states = await single(
      tx,
      "SELECT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4) AS staff," +
        "EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4) AS checkout," +
        "EXISTS (SELECT 1 FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) AS terminated," +
        "COALESCE((SELECT status FROM rms_ordering.order_closure_version WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY closure_version DESC LIMIT 1),'Open') AS closure," +
        "EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3) " +
        "OR EXISTS (SELECT 1 FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND kind='Fulfillment') AS completed",
      [brand, store, order, batch],
    );
    if (
      !states ||
      typeof states.staff !== "boolean" ||
      typeof states.checkout !== "boolean" ||
      typeof states.terminated !== "boolean" ||
      typeof states.completed !== "boolean" ||
      (states.closure !== "Open" && states.closure !== "Closed")
    )
      return unavailable();
    if (states.staff || states.checkout || states.terminated)
      return notEligible("AlreadyCancelled");
    if (states.closure === "Closed") return notEligible("Closed");
    if (states.completed) return notEligible("Completed");
    const acceptance = await single(
      tx,
      "SELECT accepted_at FROM rms_ordering.order_acceptance_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 LIMIT 2",
      [brand, store, order, batch],
    );
    const paid = await single(
      tx,
      "SELECT disposition_id::text AS disposition,submission_id::text AS submission,payment_transaction_id::text AS transaction,payment_intent_id::text AS intent," +
        "payment_attempt_id::text AS attempt,payment_event_id::text AS event,confirmed_at FROM rms_ordering.order_payment_disposition_record " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 AND disposition='Confirmed' LIMIT 2",
      [brand, store, order, batch],
    );
    // DEC-TABLE-CLOSE-GUESTS-LEFT: a dine-in round the guest paid for that was never accepted is
    // cancelled from the payment Ordering recorded as waiting for acceptance (no disposition yet).
    let payment: Readonly<Record<string, unknown>> | null = null;
    let since: string | null = null;
    let previousPhase: "Accepted" | "Submitted" = "Accepted";
    if (acceptance && paid) {
      if (paid.submission !== target.submission) return unavailable();
      payment = {
        dispositionReference: paid.disposition,
        paymentTransactionReference: paid.transaction,
        paymentIntentReference: paid.intent,
        paymentAttemptReference: paid.attempt,
        paymentEventReference: paid.event,
      };
      since =
        instant(acceptance.accepted_at) > instant(paid.confirmed_at)
          ? instant(acceptance.accepted_at)
          : instant(paid.confirmed_at);
    } else if (!acceptance && orderType === "DineIn") {
      const disposed = await single(
        tx,
        "SELECT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4) AS disposed",
        [brand, store, order, batch],
      );
      const waits = (
        await tx.query(
          "SELECT wait_id::text AS wait,submission_id::text AS submission,payment_event_id::text AS event,evaluated_at,record_json FROM rms_ordering.order_payment_acceptance_wait " +
            "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 LIMIT 2",
          [brand, store, order, batch],
        )
      ).rows;
      if (typeof disposed?.disposed !== "boolean" || waits.length > 1) return unavailable();
      const wait = waits[0];
      if (disposed.disposed || !wait) return notEligible("NotConfirmed");
      const waiting = waitingPayment(wait.record_json);
      if (
        wait.submission !== target.submission ||
        waiting.dispositionReference !== wait.wait ||
        waiting.paymentEventReference !== wait.event
      )
        return unavailable();
      payment = waiting;
      since = instant(wait.evaluated_at);
      previousPhase = "Submitted";
    }
    if (payment === null || since === null) return notEligible("NotConfirmed");
    const latest = await single(
      tx,
      "SELECT revision_id::text AS revision,version,occurred_at FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY version DESC LIMIT 1",
      [brand, store, order],
    );
    if (!latest || typeof latest.version !== "number") return unavailable();
    if (latest.version !== expectedOrderVersion) return notEligible("VersionConflict");
    const items = (
      await tx.query(
        "SELECT order_item_id::text AS item FROM rms_ordering.order_item WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 ORDER BY order_item_id LIMIT 10001",
        [brand, store, order, batch],
      )
    ).rows.map((row) => row.item);
    const plan = parseStaffOrderCancellationPlan({
      orderType,
      orderReference: order,
      orderBatchReference: batch,
      submissionReference: target.submission,
      expectedOrderVersion: latest.version,
      expectedSourceCheckpoint: latest.revision,
      orderItemReferences: items,
      payment,
      previousPhase,
    });
    const occurredAt = [instant(latest.occurred_at), since].sort()[1] as string;
    return { status: "Ready", plan, occurredAt };
  }

  async function loadOperation(tx: ConsumerTransaction, operationReference: string) {
    const row = await single(
      tx,
      "SELECT " +
        selection +
        " FROM rms_ordering.order_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 LIMIT 2",
      [brand, store, operationReference],
    );
    if (!row) return null;
    const record = bind(row);
    if (
      record.brandReference !== brand ||
      record.storeReference !== store ||
      record.operationReference !== operationReference
    )
      return unavailable();
    return record;
  }

  return Object.freeze({
    /** Idempotent replay: the record this operation created, or null. */
    async loadByOperation(
      tx: ConsumerTransaction,
      operationReference: string,
    ): Promise<StaffOrderCancellationRecord | null> {
      const operation = parseOrderingReference(operationReference);
      await setScope(tx, scope);
      const record = await loadOperation(tx, operation);
      if (record === null) return null;
      await allowed(tx, record);
      return record;
    },

    async prepare(
      tx: ConsumerTransaction,
      input: {
        orderReference: string;
        orderBatchReference: string;
        expectedOrderVersion: number;
        actorReference: string;
      },
    ): Promise<StaffOrderCancellationPreparation> {
      const identity = {
        orderReference: parseOrderingReference(input.orderReference),
        orderBatchReference: parseOrderingReference(input.orderBatchReference),
        actorReference: parseOrderingReference(input.actorReference),
      };
      const expected = input.expectedOrderVersion;
      if (!Number.isSafeInteger(expected) || expected < 1 || expected >= 2147483647)
        return unavailable();
      await allowed(tx, identity);
      await setScope(tx, scope);
      await fence(tx, scope, identity.orderReference);
      const result = await evaluate(
        tx,
        identity.orderReference,
        identity.orderBatchReference,
        expected,
      );
      await allowed(tx, identity);
      return result.status === "Ready"
        ? Object.freeze({ status: "Ready" as const, plan: result.plan })
        : Object.freeze(result);
    },

    async commit(
      tx: ConsumerTransaction,
      input: {
        plan: StaffOrderCancellationPlan;
        cancellationReference: string;
        operationReference: string;
        actorReference: string;
        reasonCode: string;
        kitchenEvidenceDigest: string;
        auditReference: string;
        terminationAuditReference: string;
        cancelledAt: string;
        /**
         * DEC-TABLE-CLOSE-GUESTS-LEFT: AlreadyRefunded only for a round whose payment the caller
         * proved (from Payment, under this fence) fully refunded already. Default Refund.
         */
        refundDisposition?: StaffOrderCancellationRefundDisposition;
      },
    ): Promise<{ readonly status: "Created"; readonly record: StaffOrderCancellationRecord }> {
      const plan = parseStaffOrderCancellationPlan(input.plan);
      const cancellationReference = parseOrderingReference(input.cancellationReference),
        operationReference = parseOrderingReference(input.operationReference),
        actorReference = parseOrderingReference(input.actorReference),
        reasonCode = parseStaffOrderCancellationReasonCode(input.reasonCode),
        auditReference = parseOrderingReference(input.auditReference),
        terminationAuditReference = parseOrderingReference(input.terminationAuditReference),
        cancelledAt = parseOrderingInstant(input.cancelledAt);
      const refundDisposition = input.refundDisposition ?? "Refund";
      if (refundDisposition !== "Refund" && refundDisposition !== "AlreadyRefunded")
        return unavailable();
      const identity = {
        orderReference: plan.orderReference,
        orderBatchReference: plan.orderBatchReference,
        actorReference,
      };
      if (
        auditReference === terminationAuditReference ||
        cancellationReference === plan.expectedSourceCheckpoint
      )
        return unavailable();
      await allowed(tx, identity);
      await setScope(tx, scope);
      await fence(tx, scope, plan.orderReference);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingStaffCancellationOperation:" + brand + ":" + store + ":" + operationReference,
      ]);
      // Replay is resolved through loadByOperation before Kitchen, Inventory and Payment run.
      if ((await loadOperation(tx, operationReference)) !== null) return conflict();
      const current = await evaluate(
        tx,
        plan.orderReference,
        plan.orderBatchReference,
        plan.expectedOrderVersion,
      );
      if (
        current.status !== "Ready" ||
        canonicalizeRfc8785(current.plan) !== canonicalizeRfc8785(plan) ||
        cancelledAt < current.occurredAt
      )
        return conflict();
      const record = parseStaffOrderCancellationRecord({
        cancellationReference,
        operationReference,
        brandReference: brand,
        storeReference: store,
        orderReference: plan.orderReference,
        orderBatchReference: plan.orderBatchReference,
        submissionReference: plan.submissionReference,
        orderType: plan.orderType,
        expectedOrderVersion: plan.expectedOrderVersion,
        cancelledOrderVersion: plan.expectedOrderVersion + 1,
        expectedSourceCheckpoint: plan.expectedSourceCheckpoint,
        actorReference,
        reasonCode,
        paymentDispositionReference: plan.payment.dispositionReference,
        paymentTransactionReference: plan.payment.paymentTransactionReference,
        paymentIntentReference: plan.payment.paymentIntentReference,
        paymentAttemptReference: plan.payment.paymentAttemptReference,
        paymentEventReference: plan.payment.paymentEventReference,
        orderItemReferences: plan.orderItemReferences,
        kitchenEvidenceDigest: input.kitchenEvidenceDigest,
        sourceDigest: sha256({
          kind: "StaffOrderCancellation/v1",
          plan,
          reasonCode,
          kitchenEvidenceDigest: input.kitchenEvidenceDigest,
          ...(refundDisposition === "AlreadyRefunded" ? { refundDisposition } : {}),
        }),
        auditReference,
        cancelledAt,
        previousPhase: plan.previousPhase ?? "Accepted",
        refundDisposition,
      });
      const audit = validateAuditRecord({
        auditId: auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: actorReference },
        actionCode: "ORDER_CANCELLED_BY_STAFF",
        targetType: record.orderType === "Pickup" ? "Order" : "OrderBatch",
        targetId:
          record.orderType === "Pickup" ? record.orderReference : record.orderBatchReference,
        correlationId: operationReference,
        reasonCode,
        occurredAt: cancelledAt,
        sourceChannel: "MERCHANT_WEB",
        afterSummary: {
          phase: "Cancelled",
          previousPhase: plan.previousPhase ?? "Accepted",
          refund: refundDisposition,
        },
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      await allowed(tx, identity);
      await tx.query("SAVEPOINT ordering_staff_cancellation", []);
      try {
        if (record.orderType === "Pickup") {
          const termination = parseOrderTerminationRecord({
            terminationReference: cancellationReference,
            operationReference,
            brandReference: brand,
            storeReference: store,
            orderReference: record.orderReference,
            orderBatchReference: record.orderBatchReference,
            expectedOrderVersion: record.expectedOrderVersion,
            terminatedOrderVersion: record.cancelledOrderVersion,
            expectedSourceCheckpoint: record.expectedSourceCheckpoint,
            previousPhase: "Accepted",
            phase: "Cancelled",
            actorType: "User",
            actorReference,
            purposeCode: staffOrderCancellationPolicy.purposeCode,
            permissionCode: staffOrderCancellationPolicy.permissionCode,
            reasonCode,
            workflowVersionReference: staffOrderCancellationPolicy.workflowVersionReference,
            transitionReference: staffOrderCancellationPolicy.transitionReference,
            sourceDigest: record.sourceDigest,
            terminatedAt: cancelledAt,
          });
          const terminated = await createPostgresOrderTerminationStore({
            brandReference: brand,
            storeReference: store,
            authorize: async (transaction, candidate) =>
              transaction === tx &&
              candidate.operationReference === operationReference &&
              (await options.authorize(transaction, Object.freeze({ ...identity }))) === true,
            validateCurrentSource: async (transaction, candidate) =>
              transaction === tx && candidate.terminationReference === cancellationReference,
            audit: async (candidate) => ({
              auditId: terminationAuditReference,
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
              afterSummary: { phase: candidate.phase },
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          }).commit({ transaction: tx, record: termination });
          if (terminated.status !== "Created") return conflict();
        } else {
          const revision = await tx.query(
            "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) " +
              "SELECT $4::uuid,$1::uuid,$2::uuid,$3::uuid,'StaffBatchCancellation',$5::integer,$6::integer,r.revision_id,NULL,$7::timestamptz FROM rms_ordering.order_revision r " +
              "WHERE r.brand_id=$1::uuid AND r.store_id=$2::uuid AND r.order_id=$3::uuid AND r.version=$6::integer AND r.occurred_at<=$7::timestamptz AND r.revision_id=$8::uuid",
            [
              brand,
              store,
              record.orderReference,
              cancellationReference,
              record.cancelledOrderVersion,
              record.expectedOrderVersion,
              cancelledAt,
              record.expectedSourceCheckpoint,
            ],
          );
          if (revision.rowCount !== 1) return conflict();
        }
        const inserted = await tx.query(
          "INSERT INTO rms_ordering.order_staff_cancellation (" +
            keys.map((key) => columns[key]).join(",") +
            ",permission_code) VALUES (" +
            keys.map((_, i) => "$" + (i + 1)).join(",") +
            ",'" +
            staffOrderCancellationPolicy.permissionCode +
            "')",
          keys.map((key) =>
            key === "orderItemReferences" ? [...record.orderItemReferences] : record[key],
          ),
        );
        if (inserted.rowCount !== 1) return conflict();
        await appendAuditRecordInTransaction(tx, audit);
        await tx.query("RELEASE SAVEPOINT ordering_staff_cancellation", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_staff_cancellation", []);
        await tx.query("RELEASE SAVEPOINT ordering_staff_cancellation", []);
        return conflict();
      }
      await allowed(tx, identity);
      return Object.freeze({ status: "Created" as const, record });
    },
  });
}

/** Owner reads of staff cancellations in the caller's transaction (no eligibility inferred). */
export function createPostgresStaffOrderCancellationReader(scope: {
  brandReference: string;
  storeReference: string;
}) {
  const owner = Object.freeze({
    brandReference: parseOrderingReference(scope.brandReference),
    storeReference: parseOrderingReference(scope.storeReference),
  });
  return Object.freeze({
    /** Compensation evidence: the CancelledByStaff disposition for this payment event, or null. */
    async loadCompensationByPaymentEvent(input: {
      transaction: ConsumerTransaction;
      paymentEventReference: string;
    }): Promise<OrderPaymentOutcomeDisposition | null> {
      const event = parseOrderingReference(input.paymentEventReference);
      await setScope(input.transaction, owner);
      const rows = (
        await input.transaction.query(
          "SELECT " +
            selection +
            " FROM rms_ordering.order_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND payment_event_id=$3 LIMIT 2",
          [owner.brandReference, owner.storeReference, event],
        )
      ).rows;
      if (rows.length === 0) return null;
      const record = rows.length === 1 ? bind(rows[0]) : unavailable();
      if (
        record.brandReference !== owner.brandReference ||
        record.storeReference !== owner.storeReference ||
        record.paymentEventReference !== event
      )
        return unavailable();
      // DEC-TABLE-CLOSE-GUESTS-LEFT: already refunded in full before the cancellation; nothing owed.
      if (record.refundDisposition === "AlreadyRefunded") return null;
      return staffOrderCancellationDisposition(record);
    },
    async listByOrders(
      transaction: ConsumerTransaction,
      orderReferences: readonly string[],
    ): Promise<readonly StaffOrderCancellationRecord[]> {
      return readStaffOrderCancellations(transaction, owner, orderReferences);
    },
  });
}
