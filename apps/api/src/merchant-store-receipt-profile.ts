import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  createPostgresReceiptIssuerSource,
  createPostgresStoreReceiptIssuerRecorder,
  parseReceiptIssuerName,
  ReceiptIssuerSourceError,
} from "@bop/operating-entity";
import {
  createPostgresStoreReceiptProfileStore,
  readCurrentStoreReceiptProfile,
  storeReceiptProfileSetupGaps,
  StoreReceiptProfileError,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
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
  const denied = (): never => {
    throw new MerchantStoreReceiptProfileError("Denied");
  };
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
    if (
      error instanceof ReceiptIssuerSourceError &&
      error.code === "RECEIPT_ISSUER_PERMISSION_DENIED"
    )
      throw new MerchantStoreReceiptProfileError("Denied");
    if (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED")
      throw new MerchantStoreReceiptProfileError("Denied");
    throw new MerchantStoreReceiptProfileError("Unavailable");
  };
  const read = async (input: { sessionCookie: unknown }) => {
    try {
      // WP-2423: one authorized run. The caller, its read permission and whether it may change
      // the profile are resolved in full once at the start (one permission packet) and the read
      // permission once more before the reply.
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveStore(
                transaction,
                input.sessionCookie,
                "organization.store.read",
              );
              const decisions = await current.authorizeActions([
                "organization.store.read",
                "organization.store.publish",
              ]);
              if (decisions.get("organization.store.read")?.effect !== "Allow") return denied();
              return {
                current,
                canChange: decisions.get("organization.store.publish")?.effect === "Allow",
              };
            },
            recheck: async ({ current }) => (await current.allowed()) === true,
            denied,
          },
          async ({ scope: { current, canChange } }) => {
            const scope = {
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const profile = await readCurrentStoreReceiptProfile(
              businessTransaction(transaction),
              scope,
            );
            // v15 2026-11-01: the business the Store's receipts name (none until the Owner saves
            // this section); the Brand's name is offered for the first save.
            const issuer = await createPostgresReceiptIssuerSource({
              ...scope,
              authorize: async () => true,
            }).resolve({
              transaction: businessTransaction(transaction),
              effectiveAt: String(current.context.resolvedAt),
            });
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
              issuer: Object.freeze({
                businessName: issuer?.legalName ?? null,
                suggestedBusinessName: String(current.context.brand.displayName),
              }),
            });
          },
        ),
      );
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
    // v15 2026-11-01: `details.businessName`, the business the receipts name (its receipt issuer).
    let details: unknown = raw.details,
      businessName: string | undefined;
    if (
      details !== null &&
      typeof details === "object" &&
      Object.getPrototypeOf(details) === Object.prototype &&
      Object.hasOwn(details, "businessName")
    ) {
      const { businessName: name, ...rest } = details as Record<string, unknown>;
      try {
        businessName = parseReceiptIssuerName(name);
      } catch {
        throw new MerchantStoreReceiptProfileError("Invalid");
      }
      details = rest;
    }
    // Derived from the operation so a retry of the same save finds the same audit.
    const auditReference = approvalDerivedReference(operationReference, "store-receipt-profile");
    try {
      // WP-2423: one authorized run; the owner store's authorize takes the run's guard (no query)
      // and the caller is re-checked in full before the transaction commits.
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveStore(
                transaction,
                input.sessionCookie,
                "organization.store.publish",
                authenticated.sessionReference,
              );
              if (!(await current.allowed())) return denied();
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied,
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const actorReference = String(current.actorReference);
            const ownerTransaction = businessTransaction(transaction);
            authority.bind(ownerTransaction);
            const appendAudit = async (
              tx: unknown,
              record: object & {
                readonly actor: object;
                readonly beforeSummary: object;
                readonly afterSummary: object;
              },
            ) => {
              await appendAuditRecordInTransaction(
                tx as ConsumerTransaction,
                validateAuditRecord({
                  ...record,
                  actor: { ...record.actor },
                  beforeSummary: { ...record.beforeSummary },
                  afterSummary: { ...record.afterSummary },
                }),
              );
            };
            const recordedAt = String(current.context.resolvedAt);
            let detailsUnchanged = false;
            let result: {
              status: "Recorded" | "AlreadyRecorded";
              profile: NonNullable<Awaited<ReturnType<typeof readCurrentStoreReceiptProfile>>>;
            };
            try {
              result = await createPostgresStoreReceiptProfileStore({
                authorize: async (tx, query) =>
                  query.brandReference === scope.brandReference &&
                  query.storeReference === scope.storeReference &&
                  query.actorReference === actorReference &&
                  (await authority.guard(tx)),
                appendAudit,
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              })(ownerTransaction, {
                ...scope,
                actorReference,
                operationReference,
                auditReference,
                expectedVersion,
                recordedAt,
                details,
              });
            } catch (error) {
              // The details are as saved; the business name may still change below.
              if (
                businessName === undefined ||
                !(error instanceof StoreReceiptProfileError) ||
                error.code !== "STORE_RECEIPT_PROFILE_NO_CHANGE"
              )
                throw error;
              const saved = await readCurrentStoreReceiptProfile(ownerTransaction, scope);
              if (saved === null) throw error;
              result = { status: "AlreadyRecorded", profile: saved };
              detailsUnchanged = true;
            }
            let issuer: "Unchanged" | "Recorded" = "Unchanged";
            if (businessName !== undefined) {
              // Derived from the operation: a retry of the same save names the same records.
              const issuerAudit = approvalDerivedReference(operationReference, "receipt-issuer");
              const recorded = await createPostgresStoreReceiptIssuerRecorder({
                ...scope,
                authorize: async (tx) => authority.guard(tx),
              })({
                transaction: ownerTransaction,
                legalName: businessName,
                evidenceReference: issuerAudit,
                recordedAt,
                references: {
                  entity: approvalDerivedReference(operationReference, "receipt-issuer-entity"),
                  assignment: approvalDerivedReference(
                    operationReference,
                    "receipt-issuer-assignment",
                  ),
                },
              });
              issuer = recorded.status;
              if (issuer === "Recorded") {
                const record = {
                  auditId: issuerAudit,
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
                  actor: { type: "User", reference: actorReference },
                  actionCode: "STORE_RECEIPT_ISSUER_RECORDED",
                  targetType: "StoreReceiptIssuer",
                  targetId: scope.storeReference,
                  reasonCode: "OWNER_ENTERED",
                  correlationId: operationReference,
                  occurredAt: recordedAt,
                  sourceChannel: "MERCHANT_WEB",
                  dataClassification: "Internal",
                  beforeSummary: {},
                  afterSummary: { receiptIssuer: true },
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                };
                await appendAudit(ownerTransaction, record);
              }
            }
            if (detailsUnchanged && issuer === "Unchanged")
              throw new MerchantStoreReceiptProfileError("NoChange");
            return Object.freeze({
              status: issuer === "Recorded" ? ("Recorded" as const) : result.status,
              version: result.profile.version,
              recordedAt: result.profile.recordedAt,
              gaps: storeReceiptProfileSetupGaps(result.profile),
            });
          },
        ),
      );
    } catch (error) {
      return mapError(error);
    }
  };
  return Object.assign(command, { read });
}
