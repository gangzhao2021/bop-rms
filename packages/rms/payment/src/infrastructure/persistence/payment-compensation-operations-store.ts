import { appendAuditRecordInTransaction } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaymentCompensationCase,
  parsePaymentOperationsReconciliationReceipt,
  PaymentCompensationError,
  type PaymentCompensationCase,
  type PaymentOperationsReconciliationReceipt,
} from "../../application/paid-without-fulfillable-order.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { decodePaymentCompensationRefund } from "../../application/payment-compensation-refund-codec.js";
const fail = (
  code: PaymentCompensationError["code"] = "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new PaymentCompensationError(code);
};
export function createPostgresPaymentCompensationOperationsStore(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly authorize: (
    tx: ConsumerTransaction,
    access: {
      readonly action: "Read" | "Record";
      readonly brandReference: string;
      readonly storeReference: string;
      readonly caseReference: string;
      readonly actorReference: string | null;
      readonly purpose: "ReconcilePaidWithoutFulfillableOrder";
    },
  ) => Promise<boolean>;
  readonly validateEvidence: (
    tx: ConsumerTransaction,
    input: {
      readonly receipt: PaymentOperationsReconciliationReceipt;
      readonly caseRecord: PaymentCompensationCase;
    },
  ) => Promise<boolean>;
}) {
  const brandReference = String(parsePaymentReference(options.scope.brandReference));
  const storeReference = String(parsePaymentReference(options.scope.storeReference));
  const parse = (value: unknown) => {
    const receipt = parsePaymentOperationsReconciliationReceipt(value);
    if (receipt.brandReference !== brandReference || receipt.storeReference !== storeReference)
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    return receipt;
  };
  const authorize = async (
    tx: ConsumerTransaction,
    action: "Read" | "Record",
    caseReference: string,
    actorReference: string | null,
  ) => {
    if (
      !(await options.authorize(tx, {
        action,
        brandReference,
        storeReference,
        caseReference,
        actorReference,
        purpose: "ReconcilePaidWithoutFulfillableOrder",
      }))
    )
      return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
  };
  const read = async (tx: ConsumerTransaction, caseReference: string) => {
    const result = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_compensation_operations " +
        "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3",
      [brandReference, storeReference, caseReference],
    );
    if (!result.rows.length) return null;
    const raw = result.rows[0]?.record;
    if (result.rows.length !== 1 || typeof raw !== "string" || Buffer.byteLength(raw) > 65536)
      return fail();
    const receipt = parse(JSON.parse(raw));
    if (receipt.compensationCaseReference !== caseReference) return fail();
    return receipt;
  };
  const loadCase = async (tx: ConsumerTransaction, caseReference: string) => {
    const result = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history " +
        "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 ORDER BY version DESC LIMIT 1",
      [brandReference, storeReference, caseReference],
    );
    const raw = result.rows[0]?.record;
    if (result.rows.length !== 1 || typeof raw !== "string" || raw.length > 65536)
      return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
    const record = parsePaymentCompensationCase(JSON.parse(raw));
    if (
      record.brandReference !== brandReference ||
      record.storeReference !== storeReference ||
      record.caseReference !== caseReference
    )
      return fail();
    return record;
  };
  const run = async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => {
    try {
      return await options.transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
        return work(tx);
      });
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      return fail();
    }
  };
  return {
    async resolve(value: { readonly compensationCaseReference: string }) {
      const raw = exactPaymentObject(value, ["compensationCaseReference"]);
      const caseReference = String(parsePaymentReference(raw.compensationCaseReference));
      return run(async (tx) => {
        await authorize(tx, "Read", caseReference, null);
        const receipt = await read(tx, caseReference);
        await authorize(tx, "Read", caseReference, null);
        return receipt;
      });
    },
    async record(value: {
      readonly receipt: PaymentOperationsReconciliationReceipt;
      readonly expectedCaseVersion: number;
    }) {
      const raw = exactPaymentObject(value, ["receipt", "expectedCaseVersion"]);
      const receipt = parse(raw.receipt);
      const encoded = JSON.stringify(receipt);
      if (
        Buffer.byteLength(encoded) > 65536 ||
        typeof raw.expectedCaseVersion !== "number" ||
        !Number.isSafeInteger(raw.expectedCaseVersion) ||
        raw.expectedCaseVersion < 1
      )
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      return run(async (tx) => {
        const key = receipt.compensationCaseReference;
        await authorize(tx, "Record", key, receipt.actorReference);
        const initial = await loadCase(tx, key);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentReceiptOrder:" +
            brandReference +
            ":" +
            storeReference +
            ":" +
            initial.orderReference,
        ]);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentCompensationCase:" + brandReference + ":" + storeReference + ":" + key,
        ]);
        const current = await loadCase(tx, key);
        if (current.orderReference !== initial.orderReference) return fail();
        const existing = await read(tx, key);
        if (existing !== null) {
          await authorize(tx, "Record", key, receipt.actorReference);
          return {
            status:
              JSON.stringify(existing) === encoded ? ("Duplicate" as const) : ("Conflict" as const),
            receipt: existing,
          };
        }
        if (current.version !== raw.expectedCaseVersion || current.state !== "Open")
          return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
        const refunds = await tx.query(
          "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund " +
            "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3",
          [brandReference, storeReference, key],
        );
        if (refunds.rows.length > 1) return fail();
        if (refunds.rows.length === 1) {
          const refund = decodePaymentCompensationRefund(refunds.rows[0]?.record).fact;
          if (
            refund.brandReference !== brandReference ||
            refund.storeReference !== storeReference ||
            refund.compensationCaseReference !== key ||
            refund.refundReference !== receipt.refundReference ||
            refund.evidenceDigest !== receipt.refundEvidenceDigest
          )
            return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
        }
        if (
          receipt.reconciledAt < current.openedAt ||
          !(await options.validateEvidence(tx, { receipt, caseRecord: current }))
        )
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        const clock = await tx.query(
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          [],
        );
        const time = clock.rows[0]?.now;
        const now = parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
        if (clock.rows.length !== 1 || now < receipt.reconciledAt)
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        const result = await tx.query(
          "INSERT INTO rms_payment.payment_compensation_operations " +
            "(brand_id,store_id,receipt_id,case_id,case_version,order_id,refund_id,actor_id,audit_id,recorded_at,record_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
          [
            brandReference,
            storeReference,
            receipt.receiptReference,
            key,
            current.version,
            current.orderReference,
            receipt.refundReference,
            receipt.actorReference,
            receipt.audit.auditId,
            now,
            encoded,
          ],
        );
        if (result.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(tx, receipt.audit);
        await authorize(tx, "Record", key, receipt.actorReference);
        return { status: "Created" as const, receipt };
      });
    },
  };
}
