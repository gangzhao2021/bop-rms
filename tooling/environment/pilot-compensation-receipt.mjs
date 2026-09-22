import process from "node:process";
import { createPostgresPaymentCompensationExceptionSource } from "../../packages/rms/payment/src/index.ts";
import { createRefundReceiptIssuance } from "../../apps/api/dist/refund-receipt-issuance.js";
import { mapInternalCompensationSource } from "./pilot-compensation-projection.mjs";
import { refreshInternalOrderReceiptObservations } from "./pilot-receipt-observations.mjs";
/** Repair receipt evidence after confirmed compensation, including already closed Cases. */
export function createInternalCompensationReceiptRecovery({
  resources,
  scope,
  tenantReference,
  createSimulatedProvider,
}) {
  const active = () =>
    process.env.NODE_ENV === "development" &&
    resources.now() < resources.publicProfile.binding.validUntil &&
    tenantReference === resources.publicProfile.binding.tenantReference &&
    scope.brandReference === resources.scope.brandReference &&
    scope.storeReference === resources.scope.storeReference &&
    scope.environment === "Test";
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
    const orderReference = initial.orderReference,
      freshAfter = resources.now();
    const count = await refreshInternalOrderReceiptObservations(resources, orderReference, active, {
      providerAccountReference: scope.providerAccountReference,
      createSimulatedProvider,
    });
    if (count < 1 || !active()) return fail();
    return resources.transactions.run(async (tx) => {
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
    });
  };
}
