import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createConfiguredDiningQrContext } from "../../apps/api/dist/configured-dining-qr-context.js";
import { createConfiguredDiningGuestContext } from "../../apps/api/dist/configured-dining-guest-context.js";
import {
  RetiredTableQrError,
  createPersistentCustomerEntryComposition,
} from "../../apps/api/dist/persistent-customer-entry.js";
import { createPostgresGuestEntryAdmissionStore } from "../../packages/bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import {
  createPostgresDiningTableQrStore,
  createPostgresDiningTableStore,
  readDiningTableQrPayload,
} from "../../packages/rms/dining/src/index.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * WP-2423 Q11 (DEC-TABLE-QR-ISSUANCE): dine-in entry from the table codes staff issued and printed
 * (rms_dining.dining_table_qr_issue), replacing the per-file DEMO table codes. The presented code
 * must be exactly a stored code of this Store; the Dining QR service then verifies its signature,
 * key, lifetime and that the table's current QR version is still this code's version. A stored
 * code that was replaced or turned off is refused with plain guidance to ask staff.
 */
export async function createIssuedDiningEntries(resources, { loadProfile, loadKeys }) {
  const profile = await loadProfile();
  const keys = await loadKeys(profile);
  const { scope, transactions, credentials } = resources;
  const tableScope = {
    tenantReference: profile.binding.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  const codes = (tx) => createPostgresDiningTableQrStore(tx, tableScope);
  const tables = (tx) =>
    createPostgresDiningTableStore({ run: (work) => work(tx) }, tableScope, {
      hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      equals: (left, right) => left === right,
    });
  const registrationOf = (issue) => ({
    payload: readDiningTableQrPayload(issue),
    tableReference: issue.tableReference,
    state: "Enabled",
    contextEvidenceReference: issue.qrReference,
    validFrom: issue.issuedAt,
    validUntil: issue.expiresAt,
  });
  // The registration is the stored issue row read in the same transaction; the QR context then
  // requires the table's current QR version to equal it, so no further fence is needed here.
  const context = (registration) => ({
    binding: profile.binding,
    authorize: resources.publicProfile.authorize,
    registration,
    authorizeRegistration: async () => true,
  });
  const binding = (runner) => {
    const guest = async (session) => {
      if (session?.channel !== "DineIn" || !uuidPattern.test(String(session.qrReference)))
        return null;
      const issue = await runner.run((tx) => codes(tx).loadByQrReference(session.qrReference));
      return issue === null
        ? null
        : createConfiguredDiningGuestContext({
            ...context(registrationOf(issue)),
            transactions: runner,
          });
    };
    return {
      resolve: async (input) => (await guest(input.session))?.resolve(input) ?? null,
      validate: async (session, at) =>
        (await guest(session))?.validate(session, at) ?? "Unavailable",
    };
  };
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
        reasonCode: "TABLE_QR_ENTRY",
        correlationId: record.operationReference,
        occurredAt: record.consumedAt,
        sourceChannel: "SYSTEM",
        dataClassification: "Internal",
        retentionPolicyCode: "IDENTITY_SECURITY",
        retentionPolicyVersion: 1,
      }),
  });
  /** The stored code the token is exactly; null when this Store never issued it. */
  async function presented(tx, token) {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let hint;
    try {
      hint = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (hint?.channel !== "DineIn" || !uuidPattern.test(String(hint?.qrReference))) return null;
    const issue = await codes(tx).loadByQrReference(hint.qrReference);
    return issue !== null && issue.qrToken === token ? issue : null;
  }
  const persistent = {
    profile: resources.publicProfile,
    transactions,
    sources: async (tx, input) => {
      const issue = await presented(tx, input.qrToken);
      if (issue === null) throw new Error("ENTRY_UNAVAILABLE");
      const latest = await codes(tx).loadLatestForTable(issue.tableReference);
      if (latest === null) throw new Error("ENTRY_UNAVAILABLE");
      if (latest.qrVersion !== issue.qrVersion) throw new RetiredTableQrError("Replaced");
      const table = await tables(tx).loadTable(issue.tableReference);
      if (table?.qrStatus === "Revoked") throw new RetiredTableQrError("TurnedOff");
      const registration = registrationOf(issue);
      return {
        qr: {
          keys: keys.keys,
          verifier: keys.verifier,
          telemetry: keys.telemetry,
          contexts: createConfiguredDiningQrContext({
            ...context(registration),
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
      };
    },
  };
  const session = { credentials: credentials.sessions, binding: binding(transactions) };
  return {
    entries: [],
    qr: keys,
    binding,
    entry: { session, persistent },
    port: createPersistentCustomerEntryComposition({ ...persistent, session }),
    /** The current printable code of a table, or null (InternalTest launcher only). */
    currentToken: (tableReference) =>
      transactions.run(async (tx) => {
        const latest = await codes(tx).loadLatestForTable(tableReference);
        const table = await tables(tx).loadTable(tableReference);
        return latest !== null &&
          table?.qrStatus === "Active" &&
          table.qrVersion === latest.qrVersion
          ? latest.qrToken
          : null;
      }),
  };
}
