import { createPersistentReceiptRuntime } from "../../apps/api/dist/persistent-receipt-runtime.js";
import { createPublishedReceiptTemplateSource } from "../../apps/api/dist/published-receipt-template-source.js";
import { createStoreReceiptDetailsSource } from "../../apps/api/dist/store-receipt-details-source.js";
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
    sources: {
      scope,
      authorize,
      // WP-2423 Q15: the Store's published address and the registrations its Owner entered.
      receiptDetails: createStoreReceiptDetailsSource({
        scope: resources.scope,
        publicProfile: resources.publicProfile,
      }),
    },
    template: createInternalReceiptTemplateOptions(
      resources,
      scope.tenantReference,
      active,
      authorize,
    ),
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

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: the receipt template is the one the Store's published
 * configuration names (`receiptReference`), proved per version by its owners (installed release or
 * authored content). The operating file's template/family references are no longer used; its
 * environment still gates issuance (internal test only).
 */
export function createInternalReceiptTemplateOptions(
  resources,
  tenantReference,
  active,
  authorize,
) {
  return {
    store: { ...resources.operating, authorize: async () => active() },
    templatePublication: {
      tenantReference,
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      authorize: async () => active(),
    },
    authorize,
    now: () => new Date(resources.now()).toISOString(),
  };
}

/**
 * Whether the Store's published receipt template can be used now (read only), for the operations
 * monitor: `{ ready: true, ... }` or `{ ready: false, reason }` with reason
 * "TemplateNotProven" | "StoreConfigurationUnavailable".
 */
export async function readInternalReceiptTemplateReadiness(
  resources,
  transactions = resources.transactions,
) {
  const tenantReference = resources.publicProfile.binding.tenantReference;
  const active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const source = createPublishedReceiptTemplateSource(
    createInternalReceiptTemplateOptions(resources, tenantReference, active, async () => active()),
  );
  return transactions.run((tx) => source.readiness(tx, new Date(resources.now()).toISOString()));
}
