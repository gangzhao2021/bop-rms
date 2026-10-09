import { createPersistentReceiptRuntime } from "../../apps/api/dist/persistent-receipt-runtime.js";
import { isPilotRuntime, matchesPilotEnvironment } from "./pilot-environment.mjs";
export async function createInternalReceipt(
  resources,
  transactions = resources.transactions,
  { config, providerAccountReference },
) {
  if (!isPilotRuntime() || !matchesPilotEnvironment(config.environment))
    throw new Error("INTERNAL_RECEIPT_ONLY");
  const scope = {
    ...resources.scope,
    tenantReference: resources.publicProfile.binding.tenantReference,
    providerAccountReference: providerAccountReference,
    environment: "Test",
  };
  const active = () => resources.now() < resources.publicProfile.binding.validUntil,
    ref = resources.credentials.reference;
  const authorize = async (_tx, r) =>
    active() &&
    r.brandReference === scope.brandReference &&
    r.storeReference === scope.storeReference;
  return createPersistentReceiptRuntime({
    transactions,
    sources: { scope, authorize },
    template: {
      store: { ...resources.operating, authorize: async () => active() },
      templatePublication: {
        tenantReference: scope.tenantReference,
        templateReference: config.templateReference,
        familyReference: config.familyReference,
        configurationType: "RECEIPT_TEMPLATE",
        purposeCode: "RECEIPT_ISSUANCE",
        authorize: async () => active(),
      },
      authorize,
    },
    authorize,
    authorizeOrder: authorize,
    identities: () => ({
      recordReference: ref(),
      receiptReference: ref(),
      operationReference: ref(),
    }),
    audit: async (record, operationReference) => ({
      auditId: ref(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "DIGITAL_RECEIPT_APPEND",
      targetType: "DigitalReceipt",
      targetId: record.recordReference,
      reasonCode: "INTERNAL_TEST_RECEIPT",
      correlationId: operationReference,
      occurredAt: record.recordedAt,
      sourceChannel: "SYSTEM",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  });
}
