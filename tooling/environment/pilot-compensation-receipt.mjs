import { createPostgresPaymentCompensationExceptionSource } from "../../packages/rms/payment/src/index.ts";
import { createPostgresDigitalReceiptStore } from "../../packages/rms/ordering/src/index.ts";
import { createRefundReceiptIssuance } from "../../apps/api/dist/refund-receipt-issuance.js";
import { mapInternalCompensationSource } from "./pilot-compensation-projection.mjs";
import { refreshInternalOrderReceiptObservations } from "./pilot-receipt-observations.mjs";
import { isPilotRuntime, pilotProviderEnvironment } from "./pilot-environment.mjs";
/** Repair receipt evidence after confirmed compensation, including already closed Cases.
 *
 * WP-2423 pilot resilience (2026-10-15): a repair asks the Provider again and appends a fresh
 * observation, so it must run only while the receipt can still change. It is skipped when the
 * Order's current receipt already shows the payment fully refunded (refunds only grow), and, for a
 * Case whose confirmed refund this process has already carried to the receipt, until restart.
 * Before this, every 5 s compensation cycle re-observed every confirmed Case (~650k rows in v15),
 * which made the receipt coverage read time out and stopped the business worker.
 */
export function createInternalCompensationReceiptRecovery({
  resources,
  scope,
  tenantReference,
  createSimulatedProvider,
  maximumRememberedCases = 10_000,
}) {
  /** Cases whose confirmed refund is already on the receipt (bounded; oldest forgotten first). */
  const repaired = new Set();
  const remember = (caseReference) => {
    repaired.delete(caseReference);
    repaired.add(caseReference);
    while (repaired.size > maximumRememberedCases) repaired.delete(repaired.values().next().value);
  };
  const active = () =>
    isPilotRuntime() &&
    resources.now() < resources.publicProfile.binding.validUntil &&
    tenantReference === resources.publicProfile.binding.tenantReference &&
    scope.brandReference === resources.scope.brandReference &&
    scope.storeReference === resources.scope.storeReference &&
    scope.environment === pilotProviderEnvironment();
  const fail = () => {
    throw Error("INTERNAL_COMPENSATION_RECEIPT_UNAVAILABLE");
  };
  return async (disposition, caseReference) => {
    if (!active()) return fail();
    const owner = createPostgresPaymentCompensationExceptionSource({
      scope,
      authorize: async (_tx, q) =>
        active() &&
        q.brandReference === scope.brandReference &&
        q.storeReference === scope.storeReference &&
        q.caseReference === caseReference &&
        q.purpose === "ProjectOrderException",
    });
    const current = async (tx) => {
      const value = await owner(tx, caseReference);
      if (!value || !active()) return fail();
      return mapInternalCompensationSource({
        current: value,
        caseReference,
        scope,
        tenantReference,
        disposition,
      });
    };
    const initial = await resources.transactions.run(current);
    if (initial.providerState !== "Confirmed") return { status: "AwaitingConfirmedRefund" };
    if (repaired.has(caseReference)) return { status: "ReceiptCurrent" };
    const orderReference = initial.orderReference;
    const receiptStore = createPostgresDigitalReceiptStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async (_tx, access) =>
        active() && access.action === "Read" && access.orderReference === orderReference,
      validateSources: async () => false,
    });
    const chain = await resources.transactions.run((transaction) =>
      receiptStore.load({ transaction, orderReference }),
    );
    if (chain?.records.at(-1)?.snapshot.paymentStatus === "Refunded") {
      remember(caseReference);
      return { status: "ReceiptCurrent" };
    }
    const freshAfter = resources.now();
    const count = await refreshInternalOrderReceiptObservations(resources, orderReference, active, {
      providerAccountReference: scope.providerAccountReference,
      createSimulatedProvider,
    });
    if (count < 1 || !active()) return fail();
    return resources.transactions
      .run(async (tx) => {
        const authorize = async (t, q) =>
          t === tx &&
          active() &&
          q.brandReference === scope.brandReference &&
          q.storeReference === scope.storeReference &&
          q.orderReference === orderReference &&
          (await current(tx)).providerState === "Confirmed";
        const ref = () => resources.credentials.reference();
        const issue = createRefundReceiptIssuance({
          scope: { ...scope, tenantReference },
          authorize,
          authorizeSources: authorize,
          authorizeOrder: authorize,
          identities: () => ({ recordReference: ref(), operationReference: ref() }),
          audit: async (record, operationReference) => ({
            auditId: ref(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "DIGITAL_RECEIPT_APPEND",
            targetType: "DigitalReceipt",
            targetId: record.recordReference,
            reasonCode: "INTERNAL_TEST_REFUND_RECEIPT",
            correlationId: operationReference,
            occurredAt: record.recordedAt,
            sourceChannel: "SYSTEM",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          }),
        });
        return issue(tx, { orderReference, freshAfter, observedAt: resources.now() });
      })
      .then((result) => {
        // Issued now or already current: the confirmed refund is on the receipt.
        remember(caseReference);
        return result;
      });
  };
}
