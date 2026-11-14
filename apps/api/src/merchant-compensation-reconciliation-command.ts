import { parseOpaqueUuidV7, parseCanonicalInstant, readClosedRecord } from "@bop/identity";
import {
  createPostgresPaymentCompensationReconciliationSource,
  createPostgresPaymentCompensationOperationsStore,
  parsePaymentOperationsReconciliationReceipt,
} from "@rms/payment";
import { createMerchantRefundTransactions } from "./merchant-refund-transactions.js";
import type { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
type Preparation = Parameters<typeof createMerchantOrdinaryRefundCommand>[0];
/** Records only a named operator acknowledgment. Case closure is derived later by compensation. */
export function createMerchantCompensationReconciliationCommand(options: {
  persistence: Preparation["persistence"];
  authentication: Preparation["authentication"];
  now(): string;
}) {
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "orderReference",
      "caseReference",
      "receiptReference",
      "auditReference",
      "expectedCaseVersion",
    ]);
    const orderReference = String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID"));
    const caseReference = String(parseOpaqueUuidV7(raw.caseReference, "ACTOR_REFERENCE_INVALID"));
    const receiptReference = String(
      parseOpaqueUuidV7(raw.receiptReference, "ACTOR_REFERENCE_INVALID"),
    );
    const auditReference = String(parseOpaqueUuidV7(raw.auditReference, "ACTOR_REFERENCE_INVALID"));
    if (!Number.isSafeInteger(raw.expectedCaseVersion) || Number(raw.expectedCaseVersion) < 1)
      throw new Error("COMPENSATION_RECONCILIATION_INPUT_INVALID");
    const context = await createMerchantRefundTransactions({
      persistence: options.persistence,
      sessionCookie: input.sessionCookie,
      sessionReference: session.sessionReference,
      orderReference,
      permission: "operations.order-exception.manage",
    });
    return context.transactions.run(async (tx) => {
      const authorize = async () => context.authorize(tx, { ...context.scope, orderReference });
      const source = createPostgresPaymentCompensationReconciliationSource({
        scope: context.scope,
        authorize,
      });
      const current = await source(tx, caseReference);
      if (!current || current.caseRecord.orderReference !== orderReference)
        throw new Error("COMPENSATION_RECONCILIATION_UNAVAILABLE");
      const store = createPostgresPaymentCompensationOperationsStore({
        transactions: { run: (work) => work(tx) },
        scope: context.scope,
        authorize: async (t, access) =>
          t === tx &&
          access.brandReference === context.scope.brandReference &&
          access.storeReference === context.scope.storeReference &&
          access.caseReference === caseReference &&
          access.purpose === "ReconcilePaidWithoutFulfillableOrder" &&
          (access.action === "Read"
            ? access.actorReference === null
            : access.actorReference === context.actorReference) &&
          (await authorize()),
        validateEvidence: async (t, { receipt, caseRecord }) => {
          const fresh = await source(t, caseReference);
          return (
            fresh !== null &&
            fresh.caseRecord.orderReference === orderReference &&
            fresh.caseRecord.version === caseRecord.version &&
            receipt.actorReference === context.actorReference &&
            receipt.refundReference === fresh.refund.refundReference &&
            receipt.refundEvidenceDigest === fresh.refund.evidenceDigest &&
            receipt.reconciledAt >= fresh.refund.providerConfirmedAt &&
            (await authorize())
          );
        },
      });
      const existing = await store.resolve({ compensationCaseReference: caseReference });
      if (existing) {
        if (
          existing.receiptReference !== receiptReference ||
          existing.audit.auditId !== auditReference ||
          existing.actorReference !== context.actorReference ||
          existing.refundReference !== current.refund.refundReference ||
          existing.refundEvidenceDigest !== current.refund.evidenceDigest
        )
          throw new Error("COMPENSATION_RECONCILIATION_CONFLICT");
        return Object.freeze({ status: "Duplicate" as const, reconciledAt: existing.reconciledAt });
      }
      const reconciledAt = String(parseCanonicalInstant(options.now()));
      const receipt = parsePaymentOperationsReconciliationReceipt({
        receiptReference,
        compensationCaseReference: caseReference,
        refundReference: current.refund.refundReference,
        brandReference: context.scope.brandReference,
        storeReference: context.scope.storeReference,
        actorReference: context.actorReference,
        purpose: "ReconcilePaidWithoutFulfillableOrder",
        refundEvidenceDigest: current.refund.evidenceDigest,
        reconciledAt,
        audit: {
          auditId: auditReference,
          brandId: context.scope.brandReference,
          storeId: context.scope.storeReference,
          actor: { type: "User", reference: context.actorReference },
          actionCode: "PAYMENT_COMPENSATION_OPERATIONS_RECONCILED",
          targetType: "PaymentCompensationCase",
          targetId: caseReference,
          reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
          correlationId: receiptReference,
          occurredAt: reconciledAt,
          sourceChannel: "OPERATIONS",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
      });
      const result = await store.record({
        receipt,
        expectedCaseVersion: Number(raw.expectedCaseVersion),
      });
      if (result.status === "Conflict") throw new Error("COMPENSATION_RECONCILIATION_CONFLICT");
      return Object.freeze({ status: result.status, reconciledAt: result.receipt.reconciledAt });
    });
  };
}
