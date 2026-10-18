import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationCase,
  parsePaymentProviderConfirmedRefundFact,
  parsePaymentOperationsReconciliationReceipt,
  PaymentCompensationError,
  type PaymentCompensationCase,
  type PaymentProviderConfirmedRefundFact,
  type PaymentOperationsReconciliationReceipt,
} from "../../application/paid-without-fulfillable-order.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaidWithoutFulfillableOrderPorts } from "../../application/ports/paid-without-fulfillable-order-ports.js";
type Fence = Parameters<PaidWithoutFulfillableOrderPorts["lease"]["release"]>[0];
export interface PaymentCompensationCaseAccess {
  readonly action: "Read" | "Open" | "Reconcile";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly caseReference: string;
}
export interface PaymentCompensationCaseTransition {
  readonly current: PaymentCompensationCase;
  readonly next: PaymentCompensationCase;
  readonly refund: PaymentProviderConfirmedRefundFact | null;
  readonly operations: PaymentOperationsReconciliationReceipt | null;
}
const fail = (
  code: PaymentCompensationError["code"] = "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new PaymentCompensationError(code);
};
const encoded = (value: unknown): string => JSON.stringify(value);
const digest = (value: unknown) =>
  "sha256:" + createHash("sha256").update(encoded(value)).digest("hex");
const identityFields = [
  "caseReference",
  "operationReference",
  "dispositionReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "paymentTransactionReference",
  "paymentIntentReference",
  "paymentAttemptReference",
  "environment",
  "originalPaymentMethod",
  "reason",
  "dispositionDigest",
  "terminalEvidenceDigest",
  "severity",
] as const;
const sameIdentity = (left: PaymentCompensationCase, right: PaymentCompensationCase) =>
  identityFields.every((field) => left[field] === right[field]);

/** Immutable case history. Source ports validate actual committed facts, not caller assertions. */
export function createPostgresPaymentCompensationCaseStore(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly lease: { assertCurrent(tx: ConsumerTransaction, input: Fence): Promise<void> };
  readonly authorize: (
    tx: ConsumerTransaction,
    access: PaymentCompensationCaseAccess,
  ) => Promise<boolean>;
  readonly validateOpen: (
    tx: ConsumerTransaction,
    record: PaymentCompensationCase,
  ) => Promise<boolean>;
  readonly validateTransition: (
    tx: ConsumerTransaction,
    input: PaymentCompensationCaseTransition,
  ) => Promise<boolean>;
}): PaidWithoutFulfillableOrderPorts["cases"] {
  const brandReference = String(parsePaymentReference(options.scope.brandReference));
  const storeReference = String(parsePaymentReference(options.scope.storeReference));
  const parse = (value: unknown) => {
    let record;
    try {
      record = parsePaymentCompensationCase(value);
    } catch {
      return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
    }
    if (record.brandReference !== brandReference || record.storeReference !== storeReference)
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    return record;
  };
  const authorize = async (
    tx: ConsumerTransaction,
    action: PaymentCompensationCaseAccess["action"],
    caseReference: string,
  ) => {
    if (!(await options.authorize(tx, { action, brandReference, storeReference, caseReference })))
      return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
  };
  const scope = async (tx: ConsumerTransaction) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brandReference,
      storeReference,
    ]);
  };
  const latest = async (tx: ConsumerTransaction, caseReference: string) => {
    const result = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history " +
        "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 ORDER BY version DESC LIMIT 1",
      [brandReference, storeReference, caseReference],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.record !== "string" ||
      row.record.length > 65536
    )
      return fail();
    const decoded: unknown = JSON.parse(row.record);
    const record = parse(decoded);
    if (record.caseReference !== caseReference) return fail();
    return record;
  };
  const fenceFor = (
    record: PaymentCompensationCase,
    reference: unknown,
    version: unknown,
  ): Fence => {
    if (!Number.isSafeInteger(version) || Number(version) < 1)
      return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
    return {
      paymentAttemptReference: record.paymentAttemptReference,
      operationReference: record.operationReference,
      jobName: paidWithoutFulfillableOrderJobName,
      fenceReference: String(parsePaymentReference(reference)),
      fenceVersion: Number(version),
    };
  };
  const lock = async (tx: ConsumerTransaction, record: PaymentCompensationCase, fence: Fence) => {
    await scope(tx);
    // Shared with whole-order receipt coverage: acquire Order before Attempt and Case.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" + brandReference + ":" + storeReference + ":" + record.orderReference,
    ]);
    await options.lease.assertCurrent(tx, fence);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentCompensationCase:" +
        brandReference +
        ":" +
        storeReference +
        ":" +
        record.caseReference,
    ]);
  };
  const append = async (
    tx: ConsumerTransaction,
    record: PaymentCompensationCase,
    fence: Fence,
    auditId: string | null,
  ) => {
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    const raw = clock.rows[0]?.now;
    const at = parsePaymentInstant(raw instanceof Date ? raw.toISOString() : raw);
    if (clock.rows.length !== 1 || at < record.updatedAt)
      return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
    const result = await tx.query(
      "INSERT INTO rms_payment.payment_compensation_case_history " +
        "(brand_id,store_id,case_id,version,operation_id,payment_attempt_id,order_id,fence_id,fence_version,audit_id,updated_at,recorded_at,record_json) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)",
      [
        brandReference,
        storeReference,
        record.caseReference,
        record.version,
        record.operationReference,
        record.paymentAttemptReference,
        record.orderReference,
        fence.fenceReference,
        fence.fenceVersion,
        auditId,
        record.updatedAt,
        at,
        encoded(record),
      ],
    );
    if (result.rowCount !== 1) return fail();
  };
  const run = async <T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> => {
    try {
      return await options.transactions.run(work);
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      return fail();
    }
  };
  const sourcesMatch = (input: PaymentCompensationCaseTransition) => {
    const { current, next, refund, operations } = input;
    if (
      refund !== null &&
      (refund.compensationCaseReference !== next.caseReference ||
        refund.refundReference !== next.refundReference ||
        refund.evidenceDigest !== next.refundEvidenceDigest ||
        refund.providerConfirmedAt !== next.refundConfirmedAt ||
        refund.brandReference !== brandReference ||
        refund.storeReference !== storeReference ||
        refund.orderReference !== next.orderReference ||
        refund.paymentIntentReference !== next.paymentIntentReference ||
        refund.paymentAttemptReference !== next.paymentAttemptReference ||
        refund.paymentTransactionReference !== next.paymentTransactionReference ||
        refund.originalPaymentMethod !== next.originalPaymentMethod)
    )
      return false;
    if (
      operations !== null &&
      (operations.compensationCaseReference !== next.caseReference ||
        operations.receiptReference !== next.operationsReceiptReference ||
        operations.brandReference !== brandReference ||
        operations.storeReference !== storeReference ||
        (next.refundReference !== null && operations.refundReference !== next.refundReference) ||
        operations.refundEvidenceDigest !== next.operationsRefundEvidenceDigest ||
        operations.reconciledAt !== next.operationsReconciledAt ||
        digest(operations) !== next.operationsReceiptDigest)
    )
      return false;
    if (
      current.refundDisposition !== "ProviderConfirmed" &&
      next.refundDisposition === "ProviderConfirmed" &&
      refund === null
    )
      return false;
    if (
      current.operationsDisposition !== "Reconciled" &&
      next.operationsDisposition === "Reconciled" &&
      operations === null
    )
      return false;
    return true;
  };
  return Object.freeze({
    async resolve(value) {
      let reference;
      try {
        reference = String(
          parsePaymentReference(exactPaymentObject(value, ["caseReference"]).caseReference),
        );
      } catch {
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      return run(async (tx) => {
        await authorize(tx, "Read", reference);
        await scope(tx);
        const record = await latest(tx, reference);
        await authorize(tx, "Read", reference);
        return record;
      });
    },
    async ensure(value) {
      let record: PaymentCompensationCase,
        fence: Fence,
        audit: ReturnType<typeof validateAuditRecord>;
      try {
        const raw = exactPaymentObject(value, [
          "record",
          "audit",
          "fenceReference",
          "fenceVersion",
        ]);
        record = parse(raw.record);
        fence = fenceFor(record, raw.fenceReference, raw.fenceVersion);
        audit = validateAuditRecord(raw.audit);
        if (
          record.version !== 1 ||
          record.refundDisposition !== "NotStarted" ||
          record.operationsDisposition !== "Pending" ||
          record.openedAt !== record.updatedAt ||
          audit.brandId !== brandReference ||
          audit.storeId !== storeReference ||
          audit.actionCode !== "PAYMENT_COMPENSATION_CASE_OPENED" ||
          audit.targetType !== "PaymentCompensationCase" ||
          audit.targetId !== record.caseReference ||
          audit.correlationId !== record.caseReference ||
          audit.occurredAt !== record.openedAt ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      } catch (error) {
        if (error instanceof PaymentCompensationError) throw error;
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      return run(async (tx) => {
        await authorize(tx, "Open", record.caseReference);
        await lock(tx, record, fence);
        const prior = await latest(tx, record.caseReference);
        await authorize(tx, "Open", record.caseReference);
        if (prior)
          return sameIdentity(prior, record) &&
            record.sourceVersion >= prior.sourceVersion &&
            (record.sourceVersion !== prior.sourceVersion ||
              record.sourceSnapshotDigest === prior.sourceSnapshotDigest)
            ? { status: "Existing" as const, record: prior }
            : { status: "Conflict" as const, record: prior };
        if (!(await options.validateOpen(tx, record)))
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        await options.lease.assertCurrent(tx, fence);
        await append(tx, record, fence, audit.auditId);
        await appendAuditRecordInTransaction(tx, audit);
        await authorize(tx, "Open", record.caseReference);
        return { status: "Created" as const, record };
      });
    },
    async reconcile(value) {
      let input: PaymentCompensationCaseTransition, fence: Fence;
      try {
        const raw = exactPaymentObject(value, [
          "current",
          "next",
          "refund",
          "operations",
          "fenceReference",
          "fenceVersion",
        ]);
        input = {
          current: parse(raw.current),
          next: parse(raw.next),
          refund: raw.refund === null ? null : parsePaymentProviderConfirmedRefundFact(raw.refund),
          operations:
            raw.operations === null
              ? null
              : parsePaymentOperationsReconciliationReceipt(raw.operations),
        };
        fence = fenceFor(input.next, raw.fenceReference, raw.fenceVersion);
      } catch (error) {
        if (error instanceof PaymentCompensationError) throw error;
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      const { current, next } = input;
      if (
        !sameIdentity(current, next) ||
        current.sourceVersion !== next.sourceVersion ||
        current.sourceSnapshotDigest !== next.sourceSnapshotDigest ||
        current.openedAt !== next.openedAt ||
        next.version !== current.version + 1 ||
        next.updatedAt < current.updatedAt ||
        current.state === "Closed" ||
        next.refundDisposition === "NotStarted" ||
        !sourcesMatch(input)
      )
        return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
      for (const fields of [
        [
          "refundDisposition",
          "refundReference",
          "refundCompositionDigest",
          "refundEvidenceDigest",
          "refundConfirmedAt",
        ],
        [
          "operationsDisposition",
          "operationsReceiptReference",
          "operationsReceiptDigest",
          "operationsRefundEvidenceDigest",
          "operationsReconciledAt",
        ],
      ] as const) {
        if (
          (current.refundDisposition === "ProviderConfirmed" &&
            fields[0] === "refundDisposition") ||
          (current.operationsDisposition === "Reconciled" && fields[0] === "operationsDisposition")
        ) {
          if (fields.some((field) => current[field] !== next[field]))
            return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
        }
      }
      return run(async (tx) => {
        await authorize(tx, "Reconcile", next.caseReference);
        await lock(tx, next, fence);
        const prior = await latest(tx, next.caseReference);
        await authorize(tx, "Reconcile", next.caseReference);
        if (!prior) return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        if (encoded(prior) === encoded(next))
          return { status: "Duplicate" as const, record: prior };
        if (encoded(prior) !== encoded(current))
          return { status: "Conflict" as const, record: prior };
        if (!(await options.validateTransition(tx, input)))
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        await options.lease.assertCurrent(tx, fence);
        await append(tx, next, fence, null);
        await authorize(tx, "Reconcile", next.caseReference);
        return { status: "Updated" as const, record: next };
      });
    },
  });
}
