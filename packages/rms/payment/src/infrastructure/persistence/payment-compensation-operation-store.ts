import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationOperationRecord,
  PaymentCompensationError,
  type PaymentCompensationOperationRecord,
} from "../../application/paid-without-fulfillable-order.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaidWithoutFulfillableOrderPorts } from "../../application/ports/paid-without-fulfillable-order-ports.js";

type Fence = Parameters<PaidWithoutFulfillableOrderPorts["lease"]["release"]>[0];
export interface PaymentCompensationOperationAccess {
  readonly action: "Read" | "Commit";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly operationReference: string;
}
const fail = (
  code: PaymentCompensationError["code"] = "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new PaymentCompensationError(code);
};
const encode = (record: PaymentCompensationOperationRecord) => JSON.stringify(record);
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");

/** Replay summaries only. The actual case/refund/operations owners must validate each new result. */
export function createPostgresPaymentCompensationOperationStore(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly lease: { assertCurrent(tx: ConsumerTransaction, input: Fence): Promise<void> };
  readonly authorize: (
    tx: ConsumerTransaction,
    access: PaymentCompensationOperationAccess,
  ) => Promise<boolean>;
  readonly validateSources: (
    tx: ConsumerTransaction,
    record: PaymentCompensationOperationRecord,
  ) => Promise<boolean>;
}): PaidWithoutFulfillableOrderPorts["repository"] {
  const brandReference = String(parsePaymentReference(options.scope.brandReference));
  const storeReference = String(parsePaymentReference(options.scope.storeReference));
  const parse = (value: unknown) => {
    let record: PaymentCompensationOperationRecord;
    try {
      record = parsePaymentCompensationOperationRecord(value);
    } catch {
      return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
    }
    const disposition = record.disposition,
      result = record.result,
      source = result.exceptionSource;
    if (
      disposition.brandReference !== brandReference ||
      disposition.storeReference !== storeReference ||
      source.brandReference !== brandReference ||
      source.storeReference !== storeReference ||
      String(source.orderReference) !== String(disposition.orderReference) ||
      String(source.paymentIntentReference) !== String(disposition.paymentIntentReference) ||
      String(source.paymentAttemptReference) !== String(disposition.paymentAttemptReference) ||
      source.kind !== "PaidWithoutFulfillableOrder" ||
      String(source.openedAt) < String(disposition.evaluatedAt) ||
      record.resultDigest !== hash(JSON.stringify(record.result)) ||
      encode(record).length > 65536
    )
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    return record;
  };
  const scope = async (tx: ConsumerTransaction) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brandReference,
      storeReference,
    ]);
  };
  const authorize = async (
    tx: ConsumerTransaction,
    action: PaymentCompensationOperationAccess["action"],
    operationReference: string,
  ) => {
    if (
      !(await options.authorize(tx, { action, brandReference, storeReference, operationReference }))
    )
      return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
  };
  const latest = async (tx: ConsumerTransaction, operationReference: string) => {
    const result = await tx.query(
      "SELECT history_version::text,record_json::text AS record FROM rms_payment.payment_compensation_operation_history " +
        "WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 ORDER BY history_version DESC LIMIT 1",
      [brandReference, storeReference, operationReference],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.record !== "string" ||
      row.record.length > 65536 ||
      typeof row.history_version !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(row.history_version)
    )
      return fail();
    const version = Number(row.history_version);
    if (!Number.isSafeInteger(version)) return fail();
    const decoded: unknown = JSON.parse(row.record);
    const record = parse(decoded);
    if (record.result.operationReference !== operationReference) return fail();
    return { version, record };
  };
  const run = async <T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> => {
    try {
      return await options.transactions.run(work);
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      return fail();
    }
  };
  return Object.freeze({
    async resolveOperation(value) {
      let operationReference: string;
      try {
        operationReference = String(
          parsePaymentReference(
            exactPaymentObject(value, ["operationReference"]).operationReference,
          ),
        );
      } catch {
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      return run(async (tx) => {
        await authorize(tx, "Read", operationReference);
        await scope(tx);
        const prior = await latest(tx, operationReference);
        await authorize(tx, "Read", operationReference);
        return prior?.record ?? null;
      });
    },
    async commitOperation(value) {
      let record: PaymentCompensationOperationRecord, fence: Fence;
      try {
        const raw = exactPaymentObject(value, ["record", "fenceReference", "fenceVersion"]);
        record = parse(raw.record);
        if (!Number.isSafeInteger(raw.fenceVersion) || Number(raw.fenceVersion) < 1)
          return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
        fence = {
          paymentAttemptReference: record.disposition.paymentAttemptReference,
          operationReference: record.result.operationReference,
          jobName: paidWithoutFulfillableOrderJobName,
          fenceReference: String(parsePaymentReference(raw.fenceReference)),
          fenceVersion: Number(raw.fenceVersion),
        };
      } catch (error) {
        if (error instanceof PaymentCompensationError) throw error;
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      return run(async (tx) => {
        const operationReference = record.result.operationReference;
        await authorize(tx, "Commit", operationReference);
        // Attempt fence precedes operation fence consistently with the existing lease owner.
        await options.lease.assertCurrent(tx, fence);
        await scope(tx);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentCompensationOperation:" +
            brandReference +
            ":" +
            storeReference +
            ":" +
            operationReference,
        ]);
        const prior = await latest(tx, operationReference);
        await authorize(tx, "Commit", operationReference);
        if (prior && encode(prior.record) === encode(record))
          return { status: "Duplicate" as const, record: prior.record };
        if (prior) {
          const before = prior.record,
            old = before.result,
            next = record.result;
          if (
            before.requestDigest !== record.requestDigest ||
            JSON.stringify(before.disposition) !== JSON.stringify(record.disposition) ||
            old.caseReference !== next.caseReference ||
            old.exceptionSource.openedAt !== next.exceptionSource.openedAt ||
            old.evaluatedAt > next.evaluatedAt ||
            old.status === "Closed" ||
            (old.refundReference !== null &&
              (old.refundReference !== next.refundReference ||
                old.eventReference !== next.eventReference)) ||
            (old.exceptionSource.refundDisposition === "ProviderConfirmed" &&
              next.exceptionSource.refundDisposition !== "ProviderConfirmed") ||
            (old.exceptionSource.operationsDisposition === "Reconciled" &&
              next.exceptionSource.operationsDisposition !== "Reconciled")
          )
            return { status: "Conflict" as const, record: before };
        }
        if (!(await options.validateSources(tx, record)))
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        await options.lease.assertCurrent(tx, fence);
        const clock = await tx.query(
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          [],
        );
        const value = clock.rows[0]?.now;
        const at = parsePaymentInstant(value instanceof Date ? value.toISOString() : value);
        if (clock.rows.length !== 1 || at < record.result.evaluatedAt)
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        const version = (prior?.version ?? 0) + 1;
        if (!Number.isSafeInteger(version)) return fail();
        await authorize(tx, "Commit", operationReference);
        const result = await tx.query(
          "INSERT INTO rms_payment.payment_compensation_operation_history " +
            "(brand_id,store_id,operation_id,history_version,payment_attempt_id,order_id,case_id,fence_id,fence_version,request_digest,result_digest,evaluated_at,recorded_at,record_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)",
          [
            brandReference,
            storeReference,
            operationReference,
            version,
            record.disposition.paymentAttemptReference,
            record.disposition.orderReference,
            record.result.caseReference,
            fence.fenceReference,
            fence.fenceVersion,
            record.requestDigest,
            record.resultDigest,
            record.result.evaluatedAt,
            at,
            encode(record),
          ],
        );
        if (result.rowCount !== 1) return fail();
        await authorize(tx, "Commit", operationReference);
        return { status: prior ? ("Updated" as const) : ("Created" as const), record };
      });
    },
  });
}
