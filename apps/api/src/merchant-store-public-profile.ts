import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  canadianRegionCodes,
  createPostgresPublicStoreProfilePublisher,
  loadStoreFeatureSetting,
  normalizeStoreBusinessPhone,
  PublicStoreProfileEditError,
  type PublicStoreProfileCandidate,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import {
  approvalDerivedReference,
  businessTransaction,
} from "./merchant-ordinary-refund-approval.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { onlyRefusal } from "./merchant-failure.js";

export class MerchantStorePublicProfileError extends Error {
  constructor(
    /** PhoneRequired (M109): the Store takes pickup orders, so its phone can't be cleared. */
    readonly code:
      "Denied" | "VersionConflict" | "NoChange" | "Invalid" | "PhoneRequired" | "Unavailable",
  ) {
    super("Store public profile " + code);
    this.name = "MerchantStorePublicProfileError";
  }
}

const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/**
 * DEC-STORE-PHONE-BEFORE-PICKUP (M109): turning pickup on and leaving the profile without a phone
 * each read the other fact. Both take this Store's one hold first, so two people saving at the
 * same moment are answered one after the other and the second sees what the first committed.
 */
export async function holdStorePickupPhone(
  transaction: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  scope: { brandReference: string; storeReference: string },
): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "StorePickupPhone:" + scope.brandReference + ":" + scope.storeReference,
  ]);
}

/**
 * M109: the business phone on the Store's current published profile (null: none, or no profile
 * yet). Read only, inside the caller's authorized transaction.
 */
export async function readPublishedStoreBusinessPhone(
  transaction: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  scope: { tenantReference: string; brandReference: string; storeReference: string },
  guard: () => Promise<boolean>,
  observedAt: string,
): Promise<string | null> {
  const profile = await createPostgresPublicStoreProfilePublisher({
    ...scope,
    authorize: guard,
    hash,
    verifyMedia: async () => false,
    appendAudit: async () => {
      throw new Error("STORE_PUBLIC_PROFILE_READ_ONLY");
    },
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
  }).readCurrent(businessTransaction(transaction), observedAt);
  return profile?.businessPhone ?? null;
}

/** What staff see: the published fields only (all public), never history or references. */
function viewOf(profile: PublicStoreProfileCandidate | null) {
  if (profile === null) return null;
  return Object.freeze({
    version: profile.profileVersion,
    publishedAt: profile.publishingRelease.createdAt,
    defaultLocale: profile.defaultLocale,
    names: Object.freeze(
      profile.supportedLocales.map((locale) =>
        Object.freeze({
          locale,
          storeDisplayName: profile.localizedFields[locale]?.storeDisplayName ?? "",
        }),
      ),
    ),
    address: Object.freeze({
      addressLines: Object.freeze([...profile.address.addressLines]),
      locality: profile.address.locality,
      regionCode: profile.address.regionCode,
      postalCode: profile.address.postalCode,
      countryCode: profile.address.countryCode,
    }),
    businessPhone: profile.businessPhone,
  });
}

/**
 * WP-2423 store name (DEC-STORE-CUSTOMER-NAME): Store setup → "Name and contact shown to
 * customers". The Store's published public profile is the one owner of the name customers see:
 * the menu and order pages, the pickup panel and receipts issued from then on. Staff who can open
 * Store setup (`organization.store.read`) see it; only the Owner (`organization.store.publish`)
 * publishes a new version. Receipts already issued keep the name they were issued with.
 */
/** M109: the edit leaves the Store with no phone (a malformed edit is refused by its owner). */
function clearsPhone(details: unknown): boolean {
  if (details === null || typeof details !== "object" || !Object.hasOwn(details, "businessPhone"))
    return false;
  try {
    return (
      normalizeStoreBusinessPhone((details as { businessPhone: unknown }).businessPhone) === null
    );
  } catch {
    return false;
  }
}

export function createMerchantStorePublicProfile(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  /** Logo media is not edited here; a profile carrying a logo is verified by its owner. */
  verifyMedia?: Parameters<typeof createPostgresPublicStoreProfilePublisher>[0]["verifyMedia"];
  retentionPolicyCode?: string;
  retentionPolicyVersion?: number;
}) {
  const resolveStore = createMerchantStoreScope(options.persistence);
  const mapError = (error: unknown): never => {
    if (error instanceof MerchantStorePublicProfileError) throw error;
    if (
      error !== null &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value ===
        "TENANT_DATABASE_TRANSACTION_CONFLICT"
    )
      throw error;
    if (error instanceof PublicStoreProfileEditError) {
      if (error.code === "STORE_PUBLIC_PROFILE_DENIED")
        throw new MerchantStorePublicProfileError("Denied");
      if (error.code === "STORE_PUBLIC_PROFILE_VERSION_CONFLICT")
        throw new MerchantStorePublicProfileError("VersionConflict");
      if (error.code === "STORE_PUBLIC_PROFILE_NO_CHANGE")
        throw new MerchantStorePublicProfileError("NoChange");
      if (
        error.code === "STORE_PUBLIC_PROFILE_INVALID" ||
        error.code === "STORE_PUBLIC_PROFILE_OPERATION_CONFLICT"
      )
        throw new MerchantStorePublicProfileError("Invalid");
    }
    if (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED")
      throw new MerchantStorePublicProfileError("Denied");
    throw new MerchantStorePublicProfileError("Unavailable");
  };
  type Current = Awaited<ReturnType<typeof resolveStore>>;
  const denied = (): never => {
    throw new MerchantStorePublicProfileError("Denied");
  };
  // The caller is resolved in full at the start and once before the reply; the owner writes and
  // reads in between only confirm they run in this authorized transaction.
  const authorized = <T>(
    transaction: unknown,
    resolve: () => Promise<Current>,
    work: (current: Current, guard: () => Promise<boolean>) => Promise<T>,
  ) =>
    withMerchantTransactionAuthorization(
      {
        transaction,
        resolve: async () => {
          const current = await resolve();
          if (!(await current.allowed())) return denied();
          return current;
        },
        recheck: async (current) => (await current.allowed()) === true,
        denied,
      },
      (authority) => work(authority.scope, () => authority.guard()),
    );
  const publisherFor = (
    current: Current,
    scope: { brandReference: string; storeReference: string },
    guard: () => Promise<boolean>,
  ) =>
    createPostgresPublicStoreProfilePublisher({
      tenantReference: String(current.selected.tenantReference),
      ...scope,
      authorize: guard,
      hash,
      verifyMedia: options.verifyMedia ?? (async () => false),
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
      retentionPolicyCode: options.retentionPolicyCode ?? "CONFIGURATION_AUDIT",
      retentionPolicyVersion: options.retentionPolicyVersion ?? 1,
    });
  const scopeOf = (current: Current) => ({
    brandReference: String(current.context.brand.brandReference),
    storeReference: String(current.store.storeReference),
  });
  const read = async (input: { sessionCookie: unknown }) => {
    try {
      return await options.persistence.transactions.run((transaction) =>
        authorized(
          transaction,
          () => resolveStore(transaction, input.sessionCookie, "organization.store.read"),
          async (current, guard) => {
            const observedAt = String(current.context.resolvedAt);
            const profile = await publisherFor(current, scopeOf(current), guard).readCurrent(
              businessTransaction(transaction),
              observedAt,
            );
            const canChange =
              (await current.authorizeAction("organization.store.publish"))?.effect === "Allow";
            return Object.freeze({
              observedAt,
              canChange,
              // A Store publishing for the first time names the Store in its own language.
              locales: profile?.supportedLocales ?? [current.store.locale],
              current: viewOf(profile),
              regionCodes: canadianRegionCodes,
            });
          },
        ),
      );
    } catch (error) {
      return mapError(error);
    }
  };
  const command = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input).catch(
      onlyRefusal(() => {
        throw new MerchantStorePublicProfileError("Denied");
      }),
    );
    let raw: Readonly<Record<string, unknown>>;
    let operationReference: string;
    try {
      raw = readClosedRecord(input.command, ["expectedVersion", "operationReference", "details"]);
      operationReference = String(
        parseOpaqueUuidV7(raw.operationReference, "ACTOR_REFERENCE_INVALID"),
      );
    } catch {
      throw new MerchantStorePublicProfileError("Invalid");
    }
    if (
      typeof raw.expectedVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      raw.expectedVersion < 0
    )
      throw new MerchantStorePublicProfileError("Invalid");
    const expectedVersion = raw.expectedVersion;
    try {
      return await options.persistence.transactions.run((transaction) =>
        authorized(
          transaction,
          () =>
            resolveStore(
              transaction,
              input.sessionCookie,
              "organization.store.publish",
              authenticated.sessionReference,
            ),
          async (current, guard) => {
            // M109: pickup guests order from away from the counter; while the Store takes pickup
            // orders its phone stays on the profile (they call it about allergies or the order).
            if (clearsPhone(raw.details)) {
              await holdStorePickupPhone(transaction, scopeOf(current));
              const features = await loadStoreFeatureSetting(
                transaction as never,
                scopeOf(current),
              );
              if (features.pickup) throw new MerchantStorePublicProfileError("PhoneRequired");
            }
            const result = await publisherFor(current, scopeOf(current), guard).publish(
              businessTransaction(transaction),
              {
                actorReference: String(current.actorReference),
                operationReference,
                expectedVersion,
                recordedAt: String(current.context.resolvedAt),
                edit: raw.details,
                firstPublication: {
                  defaultLocale: current.store.locale,
                  timeZone: current.store.timeZone,
                  brandDisplayName: current.context.brand.displayName,
                },
                // Derived from the operation so a retry of the same publication finds it.
                reference: (purpose) =>
                  approvalDerivedReference(operationReference, "store-public-profile:" + purpose),
              },
            );
            return Object.freeze({
              status: result.status,
              current: viewOf(result.profile),
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
