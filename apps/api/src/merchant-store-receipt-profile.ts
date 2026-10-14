import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  createPostgresStoreReceiptProfileStore,
  readCurrentStoreReceiptProfile,
  storeReceiptProfileSetupGaps,
  StoreReceiptProfileError,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  approvalDerivedReference,
  businessTransaction,
} from "./merchant-ordinary-refund-approval.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export class MerchantStoreReceiptProfileError extends Error {
  constructor(
    readonly code: "Denied" | "VersionConflict" | "NoChange" | "Invalid" | "Unavailable",
  ) {
    super("Store receipt profile " + code);
    this.name = "MerchantStoreReceiptProfileError";
  }
}

/**
 * WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): Store setup section "Receipts and privacy". Staff
 * who can read the Store profile (`organization.store.read`) see what is entered and what is still
 * missing; only the Owner (`organization.store.publish`, the Store's legal facts) changes it. What
 * is saved is printed on receipts issued from then on and linked at checkout; receipts already
 * issued keep what they were issued with.
 */
export function createMerchantStoreReceiptProfile(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveStore = createMerchantStoreScope(options.persistence);
  const mapError = (error: unknown): never => {
    if (error instanceof MerchantStoreReceiptProfileError) throw error;
    // A serialization conflict stays visible so the read is retried (transaction-conflict-retry).
    if (
      error !== null &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value ===
        "TENANT_DATABASE_TRANSACTION_CONFLICT"
    )
      throw error;
    if (error instanceof StoreReceiptProfileError) {
      if (error.code === "STORE_RECEIPT_PROFILE_DENIED")
        throw new MerchantStoreReceiptProfileError("Denied");
      if (error.code === "STORE_RECEIPT_PROFILE_VERSION_CONFLICT")
        throw new MerchantStoreReceiptProfileError("VersionConflict");
      if (error.code === "STORE_RECEIPT_PROFILE_NO_CHANGE")
        throw new MerchantStoreReceiptProfileError("NoChange");
      if (
        error.code === "STORE_RECEIPT_PROFILE_INVALID" ||
        error.code === "STORE_RECEIPT_PROFILE_OPERATION_CONFLICT"
      )
        throw new MerchantStoreReceiptProfileError("Invalid");
    }
    if (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED")
      throw new MerchantStoreReceiptProfileError("Denied");
    throw new MerchantStoreReceiptProfileError("Unavailable");
  };
  const read = async (input: { sessionCookie: unknown }) => {
    try {
      return await options.persistence.transactions.run(async (transaction) => {
        const current = await resolveStore(
          transaction,
          input.sessionCookie,
          "organization.store.read",
        );
        if (!(await current.allowed())) throw new MerchantStoreReceiptProfileError("Denied");
        const scope = {
          brandReference: String(current.context.brand.brandReference),
          storeReference: String(current.store.storeReference),
        };
        const profile = await readCurrentStoreReceiptProfile(
          businessTransaction(transaction),
          scope,
        );
        const canChange =
          (await current.authorizeAction("organization.store.publish"))?.effect === "Allow";
        if (!(await current.allowed())) throw new MerchantStoreReceiptProfileError("Denied");
        return Object.freeze({
          observedAt: String(current.context.resolvedAt),
          canChange,
          version: profile?.version ?? 0,
          recordedAt: profile?.recordedAt ?? null,
          details: Object.freeze({
            gstHstNumber: profile?.gstHstNumber ?? null,
            qstNumber: profile?.qstNumber ?? null,
            pstNumber: profile?.pstNumber ?? null,
            privacyNoticeUrl: profile?.privacyNoticeUrl ?? null,
          }),
          gaps: storeReceiptProfileSetupGaps(profile),
        });
      });
    } catch (error) {
      return mapError(error);
    }
  };
  const command = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input).catch(() => {
      throw new MerchantStoreReceiptProfileError("Denied");
    });
    let raw: Readonly<Record<string, unknown>>;
    let operationReference: string;
    try {
      raw = readClosedRecord(input.command, ["expectedVersion", "operationReference", "details"]);
      operationReference = String(
        parseOpaqueUuidV7(raw.operationReference, "ACTOR_REFERENCE_INVALID"),
      );
    } catch {
      throw new MerchantStoreReceiptProfileError("Invalid");
    }
    if (
      typeof raw.expectedVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      raw.expectedVersion < 0
    )
      throw new MerchantStoreReceiptProfileError("Invalid");
    const expectedVersion = raw.expectedVersion;
    // Derived from the operation so a retry of the same save finds the same audit.
    const auditReference = approvalDerivedReference(operationReference, "store-receipt-profile");
    try {
      return await options.persistence.transactions.run(async (transaction) => {
        const current = await resolveStore(
          transaction,
          input.sessionCookie,
          "organization.store.publish",
          authenticated.sessionReference,
        );
        if (!(await current.allowed())) throw new MerchantStoreReceiptProfileError("Denied");
        const scope = {
          brandReference: String(current.context.brand.brandReference),
          storeReference: String(current.store.storeReference),
        };
        const actorReference = String(current.actorReference);
        const result = await createPostgresStoreReceiptProfileStore({
          authorize: async (_tx, query) =>
            query.brandReference === scope.brandReference &&
            query.storeReference === scope.storeReference &&
            query.actorReference === actorReference &&
            (await current.allowed()),
          appendAudit: async (tx, record) => {
            await appendAuditRecordInTransaction(
              tx as ConsumerTransaction,
              validateAuditRecord({
                ...record,
                actor: { ...record.actor },
                beforeSummary: { ...record.beforeSummary },
                afterSummary: { ...record.afterSummary },
              }),
            );
          },
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        })(businessTransaction(transaction), {
          ...scope,
          actorReference,
          operationReference,
          auditReference,
          expectedVersion,
          recordedAt: String(current.context.resolvedAt),
          details: raw.details,
        });
        return Object.freeze({
          status: result.status,
          version: result.profile.version,
          recordedAt: result.profile.recordedAt,
          gaps: storeReceiptProfileSetupGaps(result.profile),
        });
      });
    } catch (error) {
      return mapError(error);
    }
  };
  return Object.assign(command, { read });
}
