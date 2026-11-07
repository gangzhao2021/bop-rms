import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationActionReceipt,
  parsePaymentCompensationCase,
  parsePaymentInteracInPersonClaimReceipt,
  PaymentCompensationError,
  type PaymentCompensationActionReceipt,
  type PaymentCompensationCase,
  type PaymentInteracInPersonClaimReceipt,
} from "../../application/paid-without-fulfillable-order.js";
import {
  encodePaymentCompensationAction,
  decodePaymentCompensationAction,
} from "../../application/payment-compensation-action-codec.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaidWithoutFulfillableOrderPorts } from "../../application/ports/paid-without-fulfillable-order-ports.js";
type Fence = Parameters<PaidWithoutFulfillableOrderPorts["lease"]["release"]>[0];
type Outcome = Parameters<PaidWithoutFulfillableOrderPorts["actions"]["recordOutcome"]>[0];
const phases = ["Claimed", "InvocationUnknown", "ProviderPending", "ProviderConfirmed"];
const fail = (
  code: PaymentCompensationError["code"] = "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new PaymentCompensationError(code);
};
/** Claim Audit precedes Provider invocation; actual confirmation remains a separate financial fact. */
export function createPostgresPaymentCompensationActionStore(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly lease: { assertCurrent(tx: ConsumerTransaction, input: Fence): Promise<void> };
  readonly authorize: (
    tx: ConsumerTransaction,
    access: {
      action: "Read" | "Claim" | "Outcome";
      brandReference: string;
      storeReference: string;
      actionReference: string;
    },
  ) => Promise<boolean>;
  readonly validateClaim: (
    tx: ConsumerTransaction,
    input: {
      receipt: PaymentCompensationActionReceipt;
      caseRecord: PaymentCompensationCase;
      interacEvidence: PaymentInteracInPersonClaimReceipt | null;
    },
  ) => Promise<boolean>;
  readonly validateOutcome: (
    tx: ConsumerTransaction,
    input: {
      receipt: PaymentCompensationActionReceipt;
      caseRecord: PaymentCompensationCase;
      nextPhase: Outcome["nextPhase"];
      observedAt: string;
    },
  ) => Promise<boolean>;
}): PaidWithoutFulfillableOrderPorts["actions"] {
  const brand = String(parsePaymentReference(options.scope.brandReference)),
    store = String(parsePaymentReference(options.scope.storeReference));
  const parse = (value: unknown) => {
    const receipt = parsePaymentCompensationActionReceipt(value);
    if (receipt.amount.amountMinor > 9223372036854775807n)
      return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
    if (receipt.brandReference !== brand || receipt.storeReference !== store)
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    return receipt;
  };
  const scope = async (tx: ConsumerTransaction) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  };
  const auth = async (
    tx: ConsumerTransaction,
    action: "Read" | "Claim" | "Outcome",
    actionReference: string,
  ) => {
    if (
      !(await options.authorize(tx, {
        action,
        brandReference: brand,
        storeReference: store,
        actionReference,
      }))
    )
      return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
  };
  const latest = async (tx: ConsumerTransaction, reference: string) => {
    const result = await tx.query(
      // Order by the numeric column (h.), not the text output of the same name ("9" > "10").
      "SELECT h.history_version::text,h.observed_at,h.record_json::text AS record FROM rms_payment.payment_compensation_action_history h " +
        "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.action_id=$3 ORDER BY h.history_version DESC LIMIT 1",
      [brand, store, reference],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.record !== "string" ||
      typeof row.history_version !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(row.history_version) ||
      !Number.isSafeInteger(Number(row.history_version))
    )
      return fail();
    const receipt = decodePaymentCompensationAction(row.record);
    if (
      receipt.brandReference !== brand ||
      receipt.storeReference !== store ||
      receipt.actionReference !== reference ||
      receipt.claimDisposition !== "Claimed"
    )
      return fail();
    return {
      receipt,
      version: Number(row.history_version),
      observedAt: parsePaymentInstant(
        row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at,
      ),
    };
  };
  const loadCase = async (tx: ConsumerTransaction, receipt: PaymentCompensationActionReceipt) => {
    const result = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history " +
        "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 ORDER BY version DESC LIMIT 1",
      [brand, store, receipt.compensationCaseReference],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.record !== "string" ||
      row.record.length > 65536
    )
      return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
    const decoded: unknown = JSON.parse(row.record);
    const record = parsePaymentCompensationCase(decoded);
    if (
      record.brandReference !== brand ||
      record.storeReference !== store ||
      record.caseReference !== receipt.compensationCaseReference ||
      record.paymentTransactionReference !== receipt.paymentTransactionReference ||
      record.paymentAttemptReference !== receipt.paymentAttemptReference ||
      record.originalPaymentMethod !== receipt.originalPaymentMethod ||
      record.dispositionDigest !== receipt.dispositionDigest ||
      record.terminalEvidenceDigest !== receipt.terminalEvidenceDigest ||
      receipt.sourceVersion < record.sourceVersion ||
      (receipt.sourceVersion === record.sourceVersion &&
        receipt.sourceSnapshotDigest !== record.sourceSnapshotDigest) ||
      receipt.claimedAt < record.openedAt
    )
      return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
    return record;
  };
  const lock = async (
    tx: ConsumerTransaction,
    receipt: PaymentCompensationActionReceipt,
    reference: unknown,
    version: unknown,
  ) => {
    const before = await loadCase(tx, receipt);
    if (!Number.isSafeInteger(version) || Number(version) < 1)
      return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
    const fence: Fence = {
      paymentAttemptReference: receipt.paymentAttemptReference,
      operationReference: before.operationReference,
      jobName: paidWithoutFulfillableOrderJobName,
      fenceReference: String(parsePaymentReference(reference)),
      fenceVersion: Number(version),
    };
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" + brand + ":" + store + ":" + before.orderReference,
    ]);
    await options.lease.assertCurrent(tx, fence);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentCompensationAction:" + brand + ":" + store + ":" + receipt.actionReference,
    ]);
    const current = await loadCase(tx, receipt);
    if (
      current.orderReference !== before.orderReference ||
      current.operationReference !== before.operationReference
    )
      return fail();
    return { fence, caseRecord: current };
  };
  const append = async (
    tx: ConsumerTransaction,
    receipt: PaymentCompensationActionReceipt,
    caseRecord: PaymentCompensationCase,
    fence: Fence,
    version: number,
    observedAt: string,
    auditId: string | null,
  ) => {
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    const raw = clock.rows[0]?.now,
      now = parsePaymentInstant(raw instanceof Date ? raw.toISOString() : raw);
    if (
      clock.rows.length !== 1 ||
      now < observedAt ||
      observedAt < receipt.claimedAt ||
      !Number.isSafeInteger(version)
    )
      return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
    const result = await tx.query(
      "INSERT INTO rms_payment.payment_compensation_action_history " +
        "(brand_id,store_id,action_id,history_version,case_id,order_id,payment_attempt_id,fence_id,fence_version,phase,amount_minor,provider_idempotency_key,audit_id,observed_at,recorded_at,record_json) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)",
      [
        brand,
        store,
        receipt.actionReference,
        version,
        receipt.compensationCaseReference,
        caseRecord.orderReference,
        receipt.paymentAttemptReference,
        fence.fenceReference,
        fence.fenceVersion,
        receipt.phase,
        receipt.amount.amountMinor.toString(),
        receipt.providerIdempotencyKey,
        auditId,
        observedAt,
        now,
        encodePaymentCompensationAction(receipt),
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
  return Object.freeze({
    async resolve(value) {
      let reference;
      try {
        reference = String(
          parsePaymentReference(exactPaymentObject(value, ["actionReference"]).actionReference),
        );
      } catch {
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      return run(async (tx) => {
        await auth(tx, "Read", reference);
        await scope(tx);
        const prior = await latest(tx, reference);
        await auth(tx, "Read", reference);
        return prior?.receipt ?? null;
      });
    },
    async claim(value) {
      let receipt: PaymentCompensationActionReceipt,
        audit: ReturnType<typeof validateAuditRecord>,
        raw: Readonly<Record<string, unknown>>,
        interac: PaymentInteracInPersonClaimReceipt | null;
      try {
        raw = exactPaymentObject(value, [
          "receipt",
          "audit",
          "interacEvidence",
          "fenceReference",
          "fenceVersion",
        ]);
        receipt = parse(raw.receipt);
        audit = validateAuditRecord(raw.audit);
        interac =
          raw.interacEvidence === null
            ? null
            : parsePaymentInteracInPersonClaimReceipt(raw.interacEvidence);
        if (
          receipt.phase !== "Claimed" ||
          receipt.claimDisposition !== "Claimed" ||
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actionCode !== "PAYMENT_COMPENSATION_REFUND_CLAIMED" ||
          audit.targetType !== "PaymentCompensationAction" ||
          audit.targetId !== receipt.actionReference ||
          audit.correlationId !== receipt.compensationCaseReference ||
          audit.occurredAt !== receipt.claimedAt ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
        if (
          receipt.originalPaymentMethod === "TerminalInterac" ? interac === null : interac !== null
        )
          return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
        if (
          interac &&
          (interac.actionReference !== receipt.actionReference ||
            interac.compensationCaseReference !== receipt.compensationCaseReference ||
            interac.brandReference !== brand ||
            interac.storeReference !== store ||
            interac.paymentAttemptReference !== receipt.paymentAttemptReference ||
            interac.paymentTransactionReference !== receipt.paymentTransactionReference ||
            interac.amount.amountMinor !== receipt.amount.amountMinor ||
            interac.evidenceReference !== receipt.interacEvidenceReference ||
            interac.evidenceDigest !== receipt.interacEvidenceDigest ||
            interac.claimedAt > receipt.claimedAt)
        )
          return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
      } catch (error) {
        if (error instanceof PaymentCompensationError) throw error;
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      return run(async (tx) => {
        await auth(tx, "Claim", receipt.actionReference);
        await scope(tx);
        const { fence, caseRecord } = await lock(tx, receipt, raw.fenceReference, raw.fenceVersion);
        const prior = await latest(tx, receipt.actionReference);
        await auth(tx, "Claim", receipt.actionReference);
        if (prior) {
          if (
            encodePaymentCompensationAction({
              ...prior.receipt,
              phase: "Claimed",
              claimedAt: receipt.claimedAt,
            }) !== encodePaymentCompensationAction(receipt)
          )
            return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
          return parse({ ...prior.receipt, claimDisposition: "Existing" });
        }
        if (
          caseRecord.state !== "Open" ||
          caseRecord.refundDisposition === "ProviderConfirmed" ||
          !(await options.validateClaim(tx, { receipt, caseRecord, interacEvidence: interac }))
        )
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        await options.lease.assertCurrent(tx, fence);
        await append(tx, receipt, caseRecord, fence, 1, receipt.claimedAt, audit.auditId);
        await appendAuditRecordInTransaction(tx, audit);
        await auth(tx, "Claim", receipt.actionReference);
        return receipt;
      });
    },
    async recordOutcome(value) {
      let input: Outcome;
      try {
        const raw = exactPaymentObject(value, [
          "actionReference",
          "expectedPhase",
          "nextPhase",
          "observedAt",
          "fenceReference",
          "fenceVersion",
        ]);
        if (
          typeof raw.expectedPhase !== "string" ||
          typeof raw.nextPhase !== "string" ||
          !phases.includes(raw.expectedPhase) ||
          !phases.slice(1).includes(raw.nextPhase) ||
          !Number.isSafeInteger(raw.fenceVersion) ||
          Number(raw.fenceVersion) < 1
        )
          return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
        input = {
          actionReference: String(parsePaymentReference(raw.actionReference)),
          expectedPhase: raw.expectedPhase as Outcome["expectedPhase"],
          nextPhase: raw.nextPhase as Outcome["nextPhase"],
          observedAt: parsePaymentInstant(raw.observedAt),
          fenceReference: String(parsePaymentReference(raw.fenceReference)),
          fenceVersion: Number(raw.fenceVersion),
        };
      } catch (error) {
        if (error instanceof PaymentCompensationError) throw error;
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      }
      return run(async (tx) => {
        await auth(tx, "Outcome", input.actionReference);
        await scope(tx);
        const before = await latest(tx, input.actionReference);
        if (!before) return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        const { fence, caseRecord } = await lock(
          tx,
          before.receipt,
          input.fenceReference,
          input.fenceVersion,
        );
        const prior = await latest(tx, input.actionReference);
        if (!prior) return fail();
        await auth(tx, "Outcome", input.actionReference);
        if (prior.receipt.phase === input.nextPhase) return prior.receipt;
        if (
          prior.receipt.phase !== input.expectedPhase ||
          prior.receipt.phase === "ProviderConfirmed" ||
          (prior.receipt.phase === "ProviderPending" && input.nextPhase === "InvocationUnknown") ||
          input.observedAt < prior.observedAt
        )
          return fail("PAYMENT_COMPENSATION_OPERATION_CONFLICT");
        if (
          !(await options.validateOutcome(tx, {
            receipt: prior.receipt,
            caseRecord,
            nextPhase: input.nextPhase,
            observedAt: input.observedAt,
          }))
        )
          return fail("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        await options.lease.assertCurrent(tx, fence);
        const next = parse({ ...prior.receipt, phase: input.nextPhase });
        await append(tx, next, caseRecord, fence, prior.version + 1, input.observedAt, null);
        await auth(tx, "Outcome", input.actionReference);
        return next;
      });
    },
  });
}
