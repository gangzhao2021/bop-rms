import { createMerchantOrdinaryRefundReconciliationCommand } from "../../apps/api/dist/merchant-ordinary-refund-reconciliation-command.js";
import { createRefundReceiptIssuance } from "../../apps/api/dist/refund-receipt-issuance.js";
export function createInternalRefundReconciliationConfiguration(
  resources,
  context,
  { providerAccountReference, createSimulatedProvider, refreshOrderReceiptObservations },
) {
  const expected = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  for (const key of ["tenantReference", "brandReference", "storeReference"])
    if (context.scope[key] !== expected[key])
      throw Error("INTERNAL_REFUND_RECONCILIATION_SCOPE_DENIED");
  const scope = {
    ...expected,
    providerAccountReference: providerAccountReference,
    environment: "Test",
  };
  const active = async (tx) =>
    resources.now() < resources.publicProfile.binding.validUntil &&
    (await context.resolveAuthority(tx)).authorize();
  return {
    providerAccountReference: scope.providerAccountReference,
    environment: scope.environment,
    provider: {
      lookupRefund: async (request) => {
        const simulator = await createSimulatedProvider();
        try {
          return await simulator.adapter.lookupRefund(request);
        } finally {
          simulator.close();
        }
      },
    },
    refreshReceiptSources: async ({ orderReference }) => {
      const freshAfter = resources.now();
      const count = await refreshOrderReceiptObservations(
        { ...resources, transactions: context.transactions },
        orderReference,
        () => context.transactions.run(active),
      );
      if (count < 1) throw Error("INTERNAL_REFUND_RECEIPT_SOURCES_UNAVAILABLE");
      return { freshAfter };
    },
    issueRefundReceipt: async (tx, request) => {
      const authorize = async (t, q) =>
        t === tx &&
        q.brandReference === scope.brandReference &&
        q.storeReference === scope.storeReference &&
        q.orderReference === request.orderReference &&
        (await active(t));
      const ref = resources.credentials.reference;
      const issuer = createRefundReceiptIssuance({
        scope,
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
      return issuer(tx, { ...request, observedAt: resources.now() });
    },
  };
}
export function createInternalRefundReconciliation({
  resources,
  persistence,
  authentication,
  ...dependencies
}) {
  return createMerchantOrdinaryRefundReconciliationCommand({
    persistence,
    authentication,
    resolveConfiguration: async (context) =>
      createInternalRefundReconciliationConfiguration(resources, context, dependencies),
  });
}
