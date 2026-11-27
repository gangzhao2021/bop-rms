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
  /**
   * `oneTransaction` (WP-2423 item 4): the runner lends one transaction to a single Guest Session
   * binding check (pilot-customer-entry). Within it the guest's QR/table context is resolved once
   * per session and instant and reused for the check's later purposes: here registration
   * authorization is constant and public-store authorization only tells CustomerEntry from the
   * other purposes, and the Brand and Store rows it read stay share-locked by this same
   * transaction (the issued code row is append-only). The table row is read without a lock
   * (WP-2423 M68 lock order, DEC-DATABASE-RESILIENCE (c)): every purpose of this one check is
   * answered from the table as committed at that read, so a QR rotation, block or close that
   * commits while the check is still running is not seen by it. That is the check answering at
   * the instant of its read, as it would have a moment earlier: the check itself changes no table
   * fact, and the old share lock also ended with this transaction, before the guest's next step.
   * Each later step checks again in its own transaction, and a Dining write fence takes
   * `DiningTable:<table>` and the row lock and re-reads the table (open, Available, this session)
   * before it writes (dining-table-lock-order acceptance: a guest's call that checked a table
   * staff then blocked, or whose QR code staff then replaced, is refused).
   */
  /**
   * WP-2423 M35 (DEC-STAFF-ROUND-SPEED): an issued table code is append-only (never changed or
   * removed; replacing or turning off a code is a new fact on the table, which each check still
   * reads), so the issue row a guest's session names is read once per process instead of once per
   * check. Only codes this Store issued are kept (the read is scoped to it), at most 4,096.
   */
  const issuedCodes = new Map();
  const issuedCode = async (runner, qrReference) => {
    const known = issuedCodes.get(qrReference);
    if (known !== undefined) return known;
    const issue = await runner.run((tx) => codes(tx).loadByQrReference(qrReference));
    if (issue === null) return null;
    if (issuedCodes.size >= 4096) issuedCodes.delete(issuedCodes.keys().next().value);
    issuedCodes.set(qrReference, issue);
    return issue;
  };
  const binding = (runner, { oneTransaction = false } = {}) => {
    const resolved = oneTransaction ? new Map() : null;
    const guest = async (session) => {
      if (session?.channel !== "DineIn" || !uuidPattern.test(String(session.qrReference)))
        return null;
      const issue = await issuedCode(runner, String(session.qrReference));
      return issue === null
        ? null
        : createConfiguredDiningGuestContext({
            ...context(registrationOf(issue)),
            transactions: runner,
          });
    };
    const resolve = async (input) => {
      const key =
        resolved === null
          ? null
          : JSON.stringify([input?.session, input?.observedAt, input?.purpose === "CustomerEntry"]);
      if (key !== null && resolved.has(key)) return resolved.get(key);
      const current = (await (await guest(input?.session))?.resolve(input)) ?? null;
      if (key !== null) resolved.set(key, current);
      return current;
    };
    return {
      resolve,
      validate: async (session, at) =>
        (await resolve({ session, observedAt: at, purpose: "GuestSessionBinding" })) === null
          ? "Unavailable"
          : "Current",
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
