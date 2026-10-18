import { createHash } from "node:crypto";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import {
  parseStaffOrderCancellationReasonCode,
  staffOrderCancellationPolicy,
  StaffOrderCancellationError,
} from "../../application/staff-order-cancellation.js";
import {
  parseStaffItemCancellationPlan,
  parseStaffItemCancellationRecord,
  parseStaffItemCancellationSelection,
  type StaffItemCancellationPlan,
  type StaffItemCancellationRecord,
} from "../../application/staff-item-cancellation.js";

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
  refundRequestReference: "refund_request_id",
  refundOperationReference: "refund_operation_id",
  refundAmountMinor: "refund_amount_minor",
  currencyCode: "currency_code",
  sourceDigest: "source_digest",
  auditReference: "audit_id",
  cancelledAt: "cancelled_at",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[];
const selection = keys
  .map((key) =>
    key === "cancelledAt"
      ? 'to_char(cancelled_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "cancelledAt"'
      : key === "orderItemReferences"
        ? 'order_item_ids::text[] AS "orderItemReferences"'
        : key === "refundAmountMinor"
          ? 'refund_amount_minor::text AS "refundAmountMinor"'
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
  return parseStaffItemCancellationRecord({ ...row });
}

/** The digest Payment binds its Cancellation refund claim to (record minus its own digest). */
export function staffItemCancellationDigest(input: {
  readonly plan: StaffItemCancellationPlan;
  readonly reasonCode: string;
  readonly kitchenEvidenceDigest: string;
  readonly refundRequestReference: string;
  readonly refundOperationReference: string;
  readonly refundAmountMinor: bigint;
}): string {
  return sha256({
    kind: "StaffItemCancellation/v1",
    plan: input.plan,
    reasonCode: input.reasonCode,
    kitchenEvidenceDigest: input.kitchenEvidenceDigest,
    refundRequestReference: input.refundRequestReference,
    refundOperationReference: input.refundOperationReference,
    refundAmountMinor: input.refundAmountMinor.toString(),
  });
}

/**
 * Item cancellations of the given Orders (at most 100), in cancellation order. Caller authorizes
 * and owns the transaction; an Order line is cancelled at most once.
 */
export async function readStaffItemCancellations(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<readonly StaffItemCancellationRecord[]> {
  if (orderReferences.length === 0) return Object.freeze([]);
  if (orderReferences.length > 100) return unavailable();
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  await setScope(tx, { brandReference: brand, storeReference: store });
  const found = await tx.query(
    "SELECT " +
      selection +
      " FROM rms_ordering.order_item_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) ORDER BY cancellation_id LIMIT 10001",
    [brand, store, orders],
  );
  if (!Array.isArray(found.rows) || found.rows.length > 10000) return unavailable();
  const lines = new Set<string>();
  return Object.freeze(
    found.rows.map((row) => {
      const record = bind(row);
      if (
        record.brandReference !== brand ||
        record.storeReference !== store ||
        !orders.includes(record.orderReference as never) ||
        record.orderItemReferences.some((line) => lines.has(line))
      )
        return unavailable();
      for (const line of record.orderItemReferences) lines.add(line);
      return record;
    }),
  );
}

/**
 * The submitted cart line of every line of one Batch and whether staff already cancelled it, in
 * uuid order. Used to release stock line by line once a Batch has item cancellations.
 */
export async function readStaffBatchLineSources(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReference: string,
  orderBatchReference: string,
): Promise<
  readonly Readonly<{
    orderItemReference: string;
    sourceCartLineReference: string;
    itemCancelled: boolean;
  }>[]
> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(orderReference),
    batch = parseOrderingReference(orderBatchReference);
  await setScope(tx, { brandReference: brand, storeReference: store });
  const rows = (
    await tx.query(
      "SELECT order_item_id::text AS item,source_cart_line_id::text AS line FROM rms_ordering.order_item " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 ORDER BY order_item_id LIMIT 10001",
      [brand, store, order, batch],
    )
  ).rows;
  if (rows.length === 0 || rows.length > 10000) return unavailable();
  const cancelled = new Set(
    (
      await readStaffItemCancellations(tx, { brandReference: brand, storeReference: store }, [
        order,
      ])
    )
      .filter((record) => record.orderBatchReference === batch)
      .flatMap((record) => record.orderItemReferences),
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        orderItemReference: parseOrderingReference(row.item),
        sourceCartLineReference: parseOrderingReference(row.line),
        itemCancelled: cancelled.has(String(row.item)),
      }),
    ),
  );
}

export type StaffItemCancellationNotEligibleReason =
  | "NotFound"
  | "VersionConflict"
  | "NotConfirmed"
  | "AlreadyCancelled"
  | "Completed"
  | "Closed"
  | "ItemNotInBatch"
  | "ItemAlreadyCancelled";
export type StaffItemCancellationPreparation = Readonly<
  | { status: "Ready"; plan: StaffItemCancellationPlan }
  | { status: "NotEligible"; reason: StaffItemCancellationNotEligibleReason }
>;

/**
 * WP-2423 Q6 step 2a: store staff cancel whole item lines of a paid (captured, Confirmed) and
 * accepted Batch before the kitchen starts them. The Order stays active: a StaffItemCancellation
 * revision advances the Order version and the append-only record binds the cancelled lines, the
 * Kitchen evidence and the Payment ordinary refund claim (kind Cancellation) for exactly those
 * lines. The caller composes Kitchen, Payment and Inventory in the same transaction and owns
 * commit/rollback; any thrown failure must roll the whole command back.
 */
export function createPostgresStaffItemCancellationStore(options: {
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
    selected: readonly string[],
    expectedOrderVersion: number,
  ): Promise<
    | { status: "Ready"; plan: StaffItemCancellationPlan; occurredAt: string }
    | { status: "NotEligible"; reason: StaffItemCancellationNotEligibleReason }
  > {
    const notEligible = (reason: StaffItemCancellationNotEligibleReason) =>
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
    if (!acceptance || !paid) return notEligible("NotConfirmed");
    if (paid.submission !== target.submission) return unavailable();
    const latest = await single(
      tx,
      "SELECT revision_id::text AS revision,version,occurred_at FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY version DESC LIMIT 1",
      [brand, store, order],
    );
    if (!latest || typeof latest.version !== "number") return unavailable();
    if (latest.version !== expectedOrderVersion) return notEligible("VersionConflict");
    const items = (
      await tx.query(
        "SELECT order_item_id::text AS item,source_cart_line_id::text AS line,quantity FROM rms_ordering.order_item " +
          "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 ORDER BY order_item_id LIMIT 10001",
        [brand, store, order, batch],
      )
    ).rows;
    if (items.length === 0 || items.length > 10000) return unavailable();
    const prior = await readStaffItemCancellations(tx, scope, [order]);
    const cancelled = new Set(
      prior
        .filter((record) => record.orderBatchReference === batch)
        .flatMap((record) => record.orderItemReferences),
    );
    const members = new Set(items.map((row) => String(row.item)));
    if (selected.some((line) => !members.has(line))) return notEligible("ItemNotInBatch");
    if (selected.some((line) => cancelled.has(line))) return notEligible("ItemAlreadyCancelled");
    const plan = parseStaffItemCancellationPlan({
      orderType,
      orderReference: order,
      orderBatchReference: batch,
      submissionReference: target.submission,
      expectedOrderVersion: latest.version,
      expectedSourceCheckpoint: latest.revision,
      lines: items
        .filter((row) => selected.includes(String(row.item)))
        .map((row) => ({
          orderItemReference: row.item,
          sourceCartLineReference: row.line,
          quantity: row.quantity,
        })),
      remainingOrderItemReferences: items
        .map((row) => String(row.item))
        .filter((line) => !selected.includes(line) && !cancelled.has(line)),
      cancelledOrderItemReferences: items
        .map((row) => String(row.item))
        .filter((line) => cancelled.has(line)),
      payment: {
        dispositionReference: paid.disposition,
        paymentTransactionReference: paid.transaction,
        paymentIntentReference: paid.intent,
        paymentAttemptReference: paid.attempt,
        paymentEventReference: paid.event,
      },
    });
    const occurredAt = [
      instant(latest.occurred_at),
      instant(acceptance.accepted_at),
      instant(paid.confirmed_at),
    ].sort()[2] as string;
    return { status: "Ready", plan, occurredAt };
  }

  async function loadOperation(tx: ConsumerTransaction, operationReference: string) {
    const row = await single(
      tx,
      "SELECT " +
        selection +
        " FROM rms_ordering.order_item_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 LIMIT 2",
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
    ): Promise<StaffItemCancellationRecord | null> {
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
        orderItemReferences: readonly string[];
        expectedOrderVersion: number;
        actorReference: string;
      },
    ): Promise<StaffItemCancellationPreparation> {
      const identity = {
        orderReference: parseOrderingReference(input.orderReference),
        orderBatchReference: parseOrderingReference(input.orderBatchReference),
        actorReference: parseOrderingReference(input.actorReference),
      };
      const selected = parseStaffItemCancellationSelection(input.orderItemReferences);
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
        selected,
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
        plan: StaffItemCancellationPlan;
        cancellationReference: string;
        operationReference: string;
        actorReference: string;
        reasonCode: string;
        kitchenEvidenceDigest: string;
        refundRequestReference: string;
        refundOperationReference: string;
        refundAmountMinor: bigint;
        auditReference: string;
        cancelledAt: string;
      },
    ): Promise<{ readonly status: "Created"; readonly record: StaffItemCancellationRecord }> {
      const plan = parseStaffItemCancellationPlan(input.plan);
      const cancellationReference = parseOrderingReference(input.cancellationReference),
        operationReference = parseOrderingReference(input.operationReference),
        actorReference = parseOrderingReference(input.actorReference),
        reasonCode = parseStaffOrderCancellationReasonCode(input.reasonCode),
        auditReference = parseOrderingReference(input.auditReference),
        cancelledAt = parseOrderingInstant(input.cancelledAt);
      const identity = {
        orderReference: plan.orderReference,
        orderBatchReference: plan.orderBatchReference,
        actorReference,
      };
      // The last remaining lines end the Batch through the whole staff cancellation instead.
      if (
        plan.remainingOrderItemReferences.length === 0 ||
        cancellationReference === plan.expectedSourceCheckpoint ||
        typeof input.refundAmountMinor !== "bigint" ||
        input.refundAmountMinor <= 0n
      )
        return unavailable();
      await allowed(tx, identity);
      await setScope(tx, scope);
      await fence(tx, scope, plan.orderReference);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingStaffItemCancellationOperation:" + brand + ":" + store + ":" + operationReference,
      ]);
      // Replay is resolved through loadByOperation before Kitchen, Payment and Inventory run.
      if ((await loadOperation(tx, operationReference)) !== null) return conflict();
      const current = await evaluate(
        tx,
        plan.orderReference,
        plan.orderBatchReference,
        plan.lines.map((line) => line.orderItemReference),
        plan.expectedOrderVersion,
      );
      if (
        current.status !== "Ready" ||
        canonicalizeRfc8785(current.plan) !== canonicalizeRfc8785(plan) ||
        cancelledAt < current.occurredAt
      )
        return conflict();
      const refundRequestReference = parseOrderingReference(input.refundRequestReference),
        refundOperationReference = parseOrderingReference(input.refundOperationReference);
      const record = parseStaffItemCancellationRecord({
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
        orderItemReferences: plan.lines.map((line) => line.orderItemReference),
        kitchenEvidenceDigest: input.kitchenEvidenceDigest,
        refundRequestReference,
        refundOperationReference,
        refundAmountMinor: input.refundAmountMinor,
        currencyCode: "CAD",
        sourceDigest: staffItemCancellationDigest({
          plan,
          reasonCode,
          kitchenEvidenceDigest: input.kitchenEvidenceDigest,
          refundRequestReference,
          refundOperationReference,
          refundAmountMinor: input.refundAmountMinor,
        }),
        auditReference,
        cancelledAt,
      });
      const audit = validateAuditRecord({
        auditId: auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: actorReference },
        actionCode: "ORDER_ITEMS_CANCELLED_BY_STAFF",
        targetType: "OrderBatch",
        targetId: record.orderBatchReference,
        correlationId: operationReference,
        reasonCode,
        occurredAt: cancelledAt,
        sourceChannel: "MERCHANT_WEB",
        afterSummary: {
          cancelledLineCount: record.orderItemReferences.length,
          remainingLineCount: plan.remainingOrderItemReferences.length,
          refundRequestReference,
        },
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      await allowed(tx, identity);
      await tx.query("SAVEPOINT ordering_staff_item_cancellation", []);
      try {
        const revision = await tx.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) " +
            "SELECT $4::uuid,$1::uuid,$2::uuid,$3::uuid,'StaffItemCancellation',$5::integer,$6::integer,r.revision_id,NULL,$7::timestamptz FROM rms_ordering.order_revision r " +
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
        const inserted = await tx.query(
          "INSERT INTO rms_ordering.order_item_staff_cancellation (" +
            keys.map((key) => columns[key]).join(",") +
            ",previous_phase,permission_code) VALUES (" +
            keys.map((_, i) => "$" + (i + 1)).join(",") +
            ",'Accepted','" +
            staffOrderCancellationPolicy.permissionCode +
            "')",
          keys.map((key) =>
            key === "orderItemReferences"
              ? [...record.orderItemReferences]
              : key === "refundAmountMinor"
                ? record.refundAmountMinor.toString()
                : record[key],
          ),
        );
        if (inserted.rowCount !== 1) return conflict();
        await appendAuditRecordInTransaction(tx, audit);
        await tx.query("RELEASE SAVEPOINT ordering_staff_item_cancellation", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_staff_item_cancellation", []);
        await tx.query("RELEASE SAVEPOINT ordering_staff_item_cancellation", []);
        return conflict();
      }
      await allowed(tx, identity);
      return Object.freeze({ status: "Created" as const, record });
    },
  });
}

/** Owner reads of item cancellations in the caller's transaction (no eligibility inferred). */
export function createPostgresStaffItemCancellationReader(scope: {
  brandReference: string;
  storeReference: string;
}) {
  const owner = Object.freeze({
    brandReference: parseOrderingReference(scope.brandReference),
    storeReference: parseOrderingReference(scope.storeReference),
  });
  return Object.freeze({
    /** The record a Payment Cancellation refund claim binds to, or null. */
    async loadByCancellation(
      transaction: ConsumerTransaction,
      cancellationReference: string,
    ): Promise<StaffItemCancellationRecord | null> {
      const reference = parseOrderingReference(cancellationReference);
      await setScope(transaction, owner);
      const rows = (
        await transaction.query(
          "SELECT " +
            selection +
            " FROM rms_ordering.order_item_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND cancellation_id=$3 LIMIT 2",
          [owner.brandReference, owner.storeReference, reference],
        )
      ).rows;
      if (rows.length === 0) return null;
      const record = rows.length === 1 ? bind(rows[0]) : unavailable();
      if (
        record.brandReference !== owner.brandReference ||
        record.storeReference !== owner.storeReference ||
        record.cancellationReference !== reference
      )
        return unavailable();
      return record;
    },
    async listByOrders(
      transaction: ConsumerTransaction,
      orderReferences: readonly string[],
    ): Promise<readonly StaffItemCancellationRecord[]> {
      return readStaffItemCancellations(transaction, owner, orderReferences);
    },
  });
}
