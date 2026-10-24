import {
  parsePaymentCompensationOperationRecord,
  parsePaymentCompensationCase,
  createPaidWithoutFulfillableExceptionSource,
  parsePaymentCompensationResult,
  type PaymentCompensationOperationRecord,
} from "../../application/paid-without-fulfillable-order.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaymentCompensationIdentitySource,
  PaymentCompensationError,
  parsePaymentOperationsReconciliationReceipt,
} from "../../application/paid-without-fulfillable-order.js";
import { decodePaymentCompensationRefund } from "../../application/payment-compensation-refund-codec.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaymentCompensationCaseTransition } from "./payment-compensation-case-store.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";
import type { PaidWithoutFulfillableOrderPorts } from "../../application/ports/paid-without-fulfillable-order-ports.js";
import { exactPaymentObject } from "../../application/payment-intent-creation.js";
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
const digest = (value: unknown) =>
  "sha256:" + createHash("sha256").update(json(value)).digest("hex");

/** Use as Case validateTransition under its retained Order/Attempt/Case fences.
 * Committed receipt matching supplements, never replaces, current source authorization.
 */
export function createPostgresPaymentCompensationEvidenceValidator(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly validateCurrentSource: (
    tx: ConsumerTransaction,
    input: PaymentCompensationCaseTransition,
  ) => Promise<boolean>;
}) {
  const brand = String(parsePaymentReference(options.scope.brandReference));
  const store = String(parsePaymentReference(options.scope.storeReference));
  return async (
    tx: ConsumerTransaction,
    input: PaymentCompensationCaseTransition,
  ): Promise<boolean> => {
    const { current, next, refund, operations } = input;
    if (
      current.brandReference !== brand ||
      next.brandReference !== brand ||
      current.storeReference !== store ||
      next.storeReference !== store ||
      current.caseReference !== next.caseReference
    )
      return false;
    if (!(await options.validateCurrentSource(tx, input))) return false;
    const parameters = [brand, store, next.caseReference];
    if (next.refundDisposition === "ProviderConfirmed" || refund !== null) {
      const result = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund " +
          "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3",
        parameters,
      );
      if (result.rows.length !== 1) return false;
      const receipt = decodePaymentCompensationRefund(result.rows[0]?.record);
      const fact = receipt.fact;
      if (
        fact.brandReference !== brand ||
        fact.storeReference !== store ||
        fact.compensationCaseReference !== next.caseReference ||
        fact.orderReference !== next.orderReference ||
        fact.paymentTransactionReference !== next.paymentTransactionReference ||
        fact.paymentIntentReference !== next.paymentIntentReference ||
        fact.paymentAttemptReference !== next.paymentAttemptReference ||
        fact.originalPaymentMethod !== next.originalPaymentMethod ||
        fact.refundReference !== next.refundReference ||
        fact.evidenceDigest !== next.refundEvidenceDigest ||
        fact.providerConfirmedAt !== next.refundConfirmedAt ||
        digest(receipt) !== next.refundCompositionDigest ||
        (refund !== null && json(refund) !== json(fact))
      )
        return false;
    }
    if (next.operationsDisposition === "Reconciled" || operations !== null) {
      const result = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_operations " +
          "WHERE brand_id=$1 AND store_id=$2 AND case_id=$3",
        parameters,
      );
      const raw = result.rows[0]?.record;
      if (result.rows.length !== 1 || typeof raw !== "string" || Buffer.byteLength(raw) > 65536)
        return false;
      const receipt = parsePaymentOperationsReconciliationReceipt(JSON.parse(raw));
      if (
        receipt.brandReference !== brand ||
        receipt.storeReference !== store ||
        receipt.compensationCaseReference !== next.caseReference ||
        receipt.receiptReference !== next.operationsReceiptReference ||
        receipt.refundEvidenceDigest !== next.operationsRefundEvidenceDigest ||
        receipt.reconciledAt !== next.operationsReconciledAt ||
        digest(receipt) !== next.operationsReceiptDigest ||
        (next.refundReference !== null && receipt.refundReference !== next.refundReference) ||
        (next.refundDisposition === "ProviderConfirmed" &&
          receipt.refundEvidenceDigest !== next.refundEvidenceDigest) ||
        (operations !== null && json(operations) !== json(receipt))
      )
        return false;
    }
    return (await options.validateCurrentSource(tx, input)) === true;
  };
}

/** Identity only: amounts and current refund claims must come from the full source reader. */
export function createPostgresPaymentCompensationIdentityReader(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  readonly authorize: (
    tx: ConsumerTransaction,
    input: Parameters<PaidWithoutFulfillableOrderPorts["source"]["resolveIdentity"]>[0],
  ) => Promise<boolean>;
}): PaidWithoutFulfillableOrderPorts["source"]["resolveIdentity"] {
  const scope = {
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(options.scope.providerAccountReference)),
    environment: options.scope.environment,
  };
  if (scope.environment !== "Test" && scope.environment !== "Live")
    throw new PaymentCompensationError("PAYMENT_COMPENSATION_INPUT_INVALID");
  return async (value) => {
    const raw = exactPaymentObject(value, [
      "brandReference",
      "storeReference",
      "orderReference",
      "paymentTransactionReference",
      "paymentIntentReference",
      "paymentAttemptReference",
    ]);
    const input = {
      brandReference: String(parsePaymentReference(raw.brandReference)),
      storeReference: String(parsePaymentReference(raw.storeReference)),
      orderReference: String(parsePaymentReference(raw.orderReference)),
      paymentTransactionReference: String(parsePaymentReference(raw.paymentTransactionReference)),
      paymentIntentReference: String(parsePaymentReference(raw.paymentIntentReference)),
      paymentAttemptReference: String(parsePaymentReference(raw.paymentAttemptReference)),
    };
    if (
      input.brandReference !== scope.brandReference ||
      input.storeReference !== scope.storeReference
    )
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
    try {
      return await options.transactions.run(async (tx) => {
        const authorize = async () => {
          if ((await options.authorize(tx, input)) !== true)
            throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
        };
        await authorize();
        const owner = createPostgresPaymentTerminalStore(
          {
            run: async (work) => work(tx),
          },
          scope,
        );
        const fact = await owner.read(input.paymentIntentReference);
        await authorize();
        if (!fact) return null;
        if (
          fact.outcome !== "Succeeded" ||
          fact.brandReference !== input.brandReference ||
          fact.storeReference !== input.storeReference ||
          fact.orderReference !== input.orderReference ||
          fact.paymentTransactionReference !== input.paymentTransactionReference ||
          fact.paymentIntentReference !== input.paymentIntentReference ||
          fact.paymentAttemptReference !== input.paymentAttemptReference ||
          fact.providerAccountReference !== scope.providerAccountReference ||
          fact.environment !== scope.environment
        )
          return null;
        const identity = { ...input, environment: scope.environment, identityVersion: 1 };
        return parsePaymentCompensationIdentitySource({
          ...identity,
          identityDigest: digest(identity),
        });
      });
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE");
    }
  };
}

/** Validates operation summaries against actual committed Case/refund/operations owners.
 * Caller still validates the original disposition and current actor/system authority. */
export function createPostgresPaymentCompensationOperationEvidence(options: {
  scope: { brandReference: string; storeReference: string };
  authorize(tx: ConsumerTransaction, record: PaymentCompensationOperationRecord): Promise<boolean>;
}) {
  const brand = String(parsePaymentReference(options.scope.brandReference)),
    store = String(parsePaymentReference(options.scope.storeReference));
  return async (tx: ConsumerTransaction, value: unknown): Promise<boolean> => {
    const record = parsePaymentCompensationOperationRecord(value),
      { disposition, result } = record;
    if (
      String(disposition.brandReference) !== brand ||
      String(disposition.storeReference) !== store ||
      !(await options.authorize(tx, record))
    )
      return false;
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    const rows = (
      await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 ORDER BY version DESC LIMIT 1",
        [brand, store, result.caseReference],
      )
    ).rows;
    const raw = rows[0]?.record;
    if (rows.length !== 1 || typeof raw !== "string" || Buffer.byteLength(raw) > 65536)
      return false;
    const current = parsePaymentCompensationCase(JSON.parse(raw));
    if (
      current.brandReference !== brand ||
      current.storeReference !== store ||
      current.caseReference !== result.caseReference ||
      current.operationReference !== result.operationReference ||
      current.dispositionReference !== String(disposition.dispositionReference) ||
      current.dispositionDigest !== String(disposition.sourceDigest) ||
      current.orderReference !== String(disposition.orderReference) ||
      current.paymentIntentReference !== String(disposition.paymentIntentReference) ||
      current.paymentAttemptReference !== String(disposition.paymentAttemptReference) ||
      current.paymentTransactionReference !== String(disposition.paymentTransactionReference) ||
      current.updatedAt !== result.evaluatedAt
    )
      return false;
    let refund = null;
    if (current.refundDisposition === "ProviderConfirmed") {
      const found = (
        await tx.query(
          "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund WHERE brand_id=$1 AND store_id=$2 AND case_id=$3",
          [brand, store, current.caseReference],
        )
      ).rows;
      if (found.length !== 1) return false;
      refund = decodePaymentCompensationRefund(found[0]?.record);
    }
    const expected = parsePaymentCompensationResult({
      status:
        current.refundDisposition === "ProviderConfirmed"
          ? current.operationsDisposition === "Reconciled"
            ? "Closed"
            : "AwaitingOperationsReconciliation"
          : current.refundDisposition,
      operationReference: current.operationReference,
      caseReference: current.caseReference,
      evaluatedAt: current.updatedAt,
      refundReference: refund?.fact.refundReference ?? null,
      eventReference: refund?.event.eventId ?? null,
      exceptionSource: createPaidWithoutFulfillableExceptionSource(current),
    });
    if (json(expected) !== json(result) || digest(result) !== record.resultDigest) return false;
    const verify = createPostgresPaymentCompensationEvidenceValidator({
      scope: { brandReference: brand, storeReference: store },
      validateCurrentSource: async (t) => t === tx && (await options.authorize(tx, record)),
    });
    return await verify(tx, {
      current,
      next: current,
      refund: refund?.fact ?? null,
      operations: null,
    });
  };
}

/** Server-owned preparation for named-actor acknowledgment; browser supplies no refund facts. */
export function createPostgresPaymentCompensationReconciliationSource(options: {
  scope: { brandReference: string; storeReference: string };
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const brand = String(parsePaymentReference(options.scope.brandReference));
  const store = String(parsePaymentReference(options.scope.storeReference));
  return async (tx: ConsumerTransaction, value: unknown) => {
    const reference = String(parsePaymentReference(value));
    if (!(await options.authorize(tx))) return null;
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    const rows = (
      await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 ORDER BY version DESC LIMIT 1",
        [brand, store, reference],
      )
    ).rows;
    const raw = rows[0]?.record;
    if (rows.length !== 1 || typeof raw !== "string" || Buffer.byteLength(raw) > 65536) return null;
    const current = parsePaymentCompensationCase(JSON.parse(raw));
    if (
      current.brandReference !== brand ||
      current.storeReference !== store ||
      current.caseReference !== reference ||
      current.refundDisposition !== "ProviderConfirmed"
    )
      return null;
    const refunds = (
      await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund WHERE brand_id=$1 AND store_id=$2 AND case_id=$3",
        [brand, store, reference],
      )
    ).rows;
    if (refunds.length !== 1) return null;
    const refund = decodePaymentCompensationRefund(refunds[0]?.record);
    const valid = await createPostgresPaymentCompensationEvidenceValidator({
      scope: options.scope,
      validateCurrentSource: options.authorize,
    })(tx, { current, next: current, refund: refund.fact, operations: null });
    return valid ? Object.freeze({ caseRecord: current, refund: refund.fact }) : null;
  };
}
