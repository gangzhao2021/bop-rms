import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import {
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationCase,
  PaymentCompensationError,
  type PaymentCompensationCase,
  type PaymentRefundCompositionReceipt,
} from "../../application/paid-without-fulfillable-order.js";
import {
  encodePaymentCompensationRefund,
  decodePaymentCompensationRefund,
  parsePaymentCompensationRefund,
} from "../../application/payment-compensation-refund-codec.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaidWithoutFulfillableOrderPorts } from "../../application/ports/paid-without-fulfillable-order-ports.js";
type Fence = Parameters<PaidWithoutFulfillableOrderPorts["lease"]["release"]>[0];
const fail = (
  code: PaymentCompensationError["code"] = "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new PaymentCompensationError(code);
};
export function createPostgresPaymentCompensationRefundStore(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly lease: { assertCurrent(tx: ConsumerTransaction, fence: Fence): Promise<void> };
  readonly authorize: (
    tx: ConsumerTransaction,
    access: {
      readonly action: "Read" | "Record";
      readonly brandReference: string;
      readonly storeReference: string;
      readonly caseReference: string;
    },
  ) => Promise<boolean>;
  /** Verify actual committed Provider evidence and full original captured amount under retained fences. */
  readonly validateEvidence: (
    tx: ConsumerTransaction,
    input: {
      readonly receipt: PaymentRefundCompositionReceipt;
      readonly caseRecord: PaymentCompensationCase;
    },
  ) => Promise<boolean>;
}): PaidWithoutFulfillableOrderPorts["refunds"] {
  const brandReference = String(parsePaymentReference(options.scope.brandReference));
  const storeReference = String(parsePaymentReference(options.scope.storeReference));
  const scoped = async (tx: ConsumerTransaction) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brandReference,
      storeReference,
    ]);
  };
  const authorize = async (
    tx: ConsumerTransaction,
    action: "Read" | "Record",
    caseReference: string,
  ) => {
    if (!(await options.authorize(tx, { action, brandReference, storeReference, caseReference })))
      return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
  };
  const read = async (tx: ConsumerTransaction, caseReference: string) => {
    const result = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund " +
        "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3",
      [brandReference, storeReference, caseReference],
    );
    if (!result.rows.length) return null;
    if (result.rows.length !== 1) return fail();
    const receipt = decodePaymentCompensationRefund(result.rows[0]?.record);
    if (
      receipt.fact.brandReference !== brandReference ||
      receipt.fact.storeReference !== storeReference ||
      receipt.fact.compensationCaseReference !== caseReference
    )
      return fail();
    return receipt;
  };
  const loadCase = async (tx: ConsumerTransaction, receipt: PaymentRefundCompositionReceipt) => {
    const fact = receipt.fact;
    const result = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history " +
        "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 ORDER BY version DESC LIMIT 1",
      [brandReference, storeReference, fact.compensationCaseReference],
    );
    const raw = result.rows[0]?.record;
    if (result.rows.length !== 1 || typeof raw !== "string" || raw.length > 65536)
      return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
    const record = parsePaymentCompensationCase(JSON.parse(raw));
    if (
      record.caseReference !== fact.compensationCaseReference ||
      record.brandReference !== brandReference ||
      record.storeReference !== storeReference ||
      record.orderReference !== fact.orderReference ||
      record.paymentTransactionReference !== fact.paymentTransactionReference ||
      record.paymentIntentReference !== fact.paymentIntentReference ||
      record.paymentAttemptReference !== fact.paymentAttemptReference ||
      record.originalPaymentMethod !== fact.originalPaymentMethod ||
      fact.providerConfirmedAt < record.openedAt
    )
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    return record;
  };
  const run = async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => {
    try {
      return await options.transactions.run(work);
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      return fail();
    }
  };
  return {
    async resolve(value) {
      const raw = exactPaymentObject(value, ["compensationCaseReference"]);
      const caseReference = String(parsePaymentReference(raw.compensationCaseReference));
      return run(async (tx) => {
        await scoped(tx);
        await authorize(tx, "Read", caseReference);
        const receipt = await read(tx, caseReference);
        await authorize(tx, "Read", caseReference);
        return receipt;
      });
    },
    async record(value) {
      const raw = exactPaymentObject(value, [
        "fact",
        "event",
        "audit",
        "fenceReference",
        "fenceVersion",
      ]);
      const receipt = parsePaymentCompensationRefund({ fact: raw.fact, event: raw.event });
      const encoded = encodePaymentCompensationRefund(receipt);
      const { fact, event } = receipt;
      if (fact.brandReference !== brandReference || fact.storeReference !== storeReference)
        return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
      const audit = validateAuditRecord(raw.audit);
      if (
        audit.brandId !== brandReference ||
        audit.storeId !== storeReference ||
        audit.actionCode !== "PAYMENT_COMPENSATION_REFUND_CONFIRMED" ||
        audit.targetType !== "PaymentRefund" ||
        audit.targetId !== fact.refundReference ||
        audit.correlationId !== fact.compensationCaseReference ||
        audit.occurredAt !== fact.providerConfirmedAt ||
        audit.dataClassification !== "Restricted" ||
        audit.beforeSummary !== undefined ||
        audit.afterSummary !== undefined
      )
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      if (
        typeof raw.fenceVersion !== "number" ||
        !Number.isSafeInteger(raw.fenceVersion) ||
        raw.fenceVersion < 1
      )
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      const fenceReference = String(parsePaymentReference(raw.fenceReference));
      const fenceVersion = raw.fenceVersion;
      return run(async (tx) => {
        await scoped(tx);
        await authorize(tx, "Record", fact.compensationCaseReference);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentReceiptOrder:" +
            brandReference +
            ":" +
            storeReference +
            ":" +
            fact.orderReference,
        ]);
        const initial = await loadCase(tx, receipt);
        const fence: Fence = {
          paymentAttemptReference: fact.paymentAttemptReference,
          operationReference: initial.operationReference,
          jobName: paidWithoutFulfillableOrderJobName,
          fenceReference,
          fenceVersion,
        };
        await options.lease.assertCurrent(tx, fence);
        const caseRecord = await loadCase(tx, receipt);
        if (caseRecord.operationReference !== initial.operationReference) return fail();
        const existing = await read(tx, fact.compensationCaseReference);
        if (existing !== null) {
          await authorize(tx, "Record", fact.compensationCaseReference);
          return {
            status:
              encodePaymentCompensationRefund(existing) === encoded
                ? ("Duplicate" as const)
                : ("Conflict" as const),
            receipt: existing,
          };
        }
        if (
          caseRecord.state !== "Open" ||
          !(await options.validateEvidence(tx, { receipt, caseRecord }))
        )
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        const clock = await tx.query(
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          [],
        );
        const now = clock.rows[0]?.now;
        const recordedAt = parsePaymentInstant(now instanceof Date ? now.toISOString() : now);
        if (clock.rows.length !== 1 || recordedAt < fact.recordedAt)
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        await options.lease.assertCurrent(tx, fence);
        const result = await tx.query(
          "INSERT INTO rms_payment.payment_compensation_refund " +
            "(brand_id,store_id,refund_id,case_id,order_id,payment_attempt_id,event_id,audit_id,fence_id,fence_version,amount_minor,recorded_at,record_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)",
          [
            brandReference,
            storeReference,
            fact.refundReference,
            fact.compensationCaseReference,
            fact.orderReference,
            fact.paymentAttemptReference,
            event.eventId,
            audit.auditId,
            fenceReference,
            fenceVersion,
            fact.amount.amountMinor.toString(),
            recordedAt,
            encoded,
          ],
        );
        if (result.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(tx, audit);
        await appendEventInTransaction(tx, event);
        await authorize(tx, "Record", fact.compensationCaseReference);
        return { status: "Created" as const, receipt };
      });
    },
  };
}
