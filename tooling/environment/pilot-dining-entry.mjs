import { Buffer } from "node:buffer";
import { createConfiguredDiningQrContext } from "../../apps/api/dist/configured-dining-qr-context.js";
import { createConfiguredDiningGuestContext } from "../../apps/api/dist/configured-dining-guest-context.js";
import { createPersistentCustomerEntryComposition } from "../../apps/api/dist/persistent-customer-entry.js";
import { createPostgresGuestEntryAdmissionStore } from "../../packages/bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
export async function createInternalDiningEntry(resources, { loadProfile, loadTable, loadQr }) {
  const profile = await loadProfile();
  const table = await loadTable();
  const qr = await loadQr(profile, table),
    { scope, transactions, credentials } = resources;
  const context = {
    binding: profile.binding,
    authorize: resources.publicProfile.authorize,
    registration: qr.registration,
    authorizeRegistration: async () => true,
  };
  const binding = (runner) =>
    createConfiguredDiningGuestContext({ ...context, transactions: runner });
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
        contexts: createConfiguredDiningQrContext({
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
              publicTableReference: request.context.publicTableReference,
              channel: "DineIn",
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

export async function createInternalDiningEntries(resources, { loadEntries }) {
  const entries = await loadEntries();
  const select = (publicTable) =>
    entries.find((entry) => entry.qr.registration.payload.publicTableReference === publicTable);
  const binding = (runner) => ({
    resolve: (input) =>
      select(input.session.publicTableReference)?.binding(runner).resolve(input) ??
      Promise.resolve(null),
    validate: (session, at) =>
      select(session.publicTableReference)?.binding(runner).validate(session, at) ??
      Promise.resolve("Unavailable"),
  });
  const persistent = {
    ...entries[0].entry.persistent,
    sources: (tx, input) => {
      if (typeof input.qrToken !== "string" || input.qrToken.length > 4096)
        throw new Error("ENTRY_UNAVAILABLE");
      const hint = JSON.parse(
        Buffer.from(input.qrToken.split(".")[1] ?? "", "base64url").toString("utf8"),
      );
      const selected = select(hint?.publicTableReference);
      if (!selected) throw new Error("ENTRY_UNAVAILABLE");
      return selected.entry.persistent.sources(tx, input);
    },
  };
  return {
    entries,
    qr: entries[0].qr,
    binding,
    entry: {
      session: {
        credentials: resources.credentials.sessions,
        binding: binding(resources.transactions),
      },
      persistent,
    },
  };
}
