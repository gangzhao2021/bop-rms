import { createConfiguredPickupQrContext } from "../../apps/api/dist/configured-pickup-qr-context.js";
import { createConfiguredPickupSessionBinding } from "../../apps/api/dist/configured-pickup-session-binding.js";
import { createPersistentCustomerEntryComposition } from "../../apps/api/dist/persistent-customer-entry.js";
import { createPostgresGuestEntryAdmissionStore } from "../../packages/bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
export async function createInternalPickupEntry(resources, { loadProfile, loadQr }) {
  const profile = await loadProfile();
  const qr = await loadQr(profile),
    { scope, transactions, credentials } = resources;
  const context = {
    binding: profile.binding,
    authorize: resources.publicProfile.authorize,
    registration: qr.registration,
    authorizeRegistration: async () => true,
  };
  const binding = (runner) =>
    createConfiguredPickupSessionBinding({ ...context, transactions: runner });
  const admission = createPostgresGuestEntryAdmissionStore({
    ...scope,
    authorize: async () => true,
    appendAudit: (tx, record) =>
      appendAuditRecordInTransaction(tx, {
        auditId: record.auditReference,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "GUEST_ENTRY_ADMISSION_CONSUMED",
        targetType: "GuestEntryAdmission",
        targetId: record.evidence.entryRequestReference,
        reasonCode: "INTERNAL_TEST_ENTRY",
        correlationId: record.operationReference,
        occurredAt: record.consumedAt,
        sourceChannel: "SYSTEM",
        dataClassification: "Internal",
        retentionPolicyCode: "IDENTITY_SECURITY",
        retentionPolicyVersion: 1,
      }),
  });
  const session = { credentials: credentials.sessions, binding: binding(transactions) };
  const persistent = {
    profile: resources.publicProfile,
    transactions,
    sources: async (tx, input) => ({
      qr: {
        keys: qr.keys,
        verifier: qr.verifier,
        telemetry: qr.telemetry,
        contexts: createConfiguredPickupQrContext({
          ...context,
          transaction: tx,
          evaluatedAt: input.requestedAt,
        }),
      },
      operatingReader: resources.operatingReader(tx),
      binding: binding({ run: (work) => work(tx) }),
      admission: {
        consume: (request) =>
          admission.consume(tx, {
            evidence: {
              decision: "Allowed",
              evidenceReference: request.entryRequestReference,
              entryRequestReference: request.entryRequestReference,
              ...request.scope,
              publicStoreReference: request.context.publicStoreReference,
              publicTableReference: null,
              channel: "Pickup",
              locale: request.context.locale,
              qrReference: request.context.qrReference,
              qrRevocationVersion: request.context.revocationVersion,
              evaluatedAt: request.requestedAt,
              validUntil: new Date(Date.parse(request.requestedAt) + 60000).toISOString(),
            },
            operationReference: request.operationReference,
            auditReference: request.operationReference,
            requestedAt: request.requestedAt,
          }),
      },
    }),
  };
  return {
    entry: { session, persistent },
    port: createPersistentCustomerEntryComposition({ ...persistent, session }),
    qr,
    binding,
  };
}
