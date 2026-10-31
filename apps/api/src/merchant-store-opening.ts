import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  assignMemberToStore,
  createPostgresCurrentMembershipSource,
  MemberDirectoryError,
  resolveActiveMembership,
  type MemberDirectoryTransaction,
} from "@bop/membership";
import {
  openStore,
  StoreOpeningError,
  storeOpeningLocales,
  storeOpeningTimeZones,
  type StoreOpeningTransaction,
} from "@bop/tenant";
import type { MerchantBffService } from "./merchant-bff-contract.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { brandOwnerAuthority } from "./merchant-sole-operator.js";
import { derivedReference } from "./merchant-products.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3a: the Brand's Owner opens another Store
 * from the Store they are signed in to. Opening a Store is a Brand decision: it needs Brand Owner
 * authority, the Brand-level `organization.brand.manage` the real Brand Owner template holds (the
 * same definition as 2000_134; coordinator 2026-10-31, after v15 refused the Brand Owner under the
 * legacy `organization.manage`, which no template grants); a Store grant alone never satisfies
 * it. The new Store is
 * recorded with the opener's place there and an audit record; its roles, configuration, go-live
 * check and menu follow in their own steps, and customers order there only once it is live.
 */
export const storeOpeningPermission = brandOwnerAuthority;
export class MerchantStoreOpeningError extends Error {
  constructor(readonly code: "PermissionDenied" | "Invalid" | "CodeTaken" | "Conflict") {
    super("MERCHANT_STORE_OPENING_" + code.toUpperCase());
    this.name = "MerchantStoreOpeningError";
  }
}
export interface MerchantStoreOpeningCommand {
  readonly operationReference: string;
  readonly code: string;
  readonly displayName: string;
  readonly timeZone: string;
  readonly locale: string;
}
const fail = (code: MerchantStoreOpeningError["code"]): never => {
  throw new MerchantStoreOpeningError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The command as the browser sent it (closed shape); never trusted for scope or identity. */
export function parseMerchantStoreOpeningCommand(value: unknown): MerchantStoreOpeningCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("Invalid");
  const record = value as Record<string, unknown>;
  const keys = ["code", "displayName", "locale", "operationReference", "timeZone"];
  if (Object.keys(record).sort().join() !== keys.join()) return fail("Invalid");
  const text = (key: string, max: number) => {
    const entry = record[key];
    return typeof entry === "string" && entry.length >= 1 && entry.length <= max
      ? entry
      : fail("Invalid");
  };
  const operationReference = text("operationReference", 36);
  if (!uuid.test(operationReference)) return fail("Invalid");
  const timeZone = text("timeZone", 64),
    locale = text("locale", 35);
  if (!storeOpeningTimeZones.includes(timeZone) || !storeOpeningLocales.includes(locale))
    return fail("Invalid");
  return Object.freeze({
    operationReference,
    code: text("code", 63),
    displayName: text("displayName", 160),
    timeZone,
    locale,
  });
}

export function createMerchantStoreOpening(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const resolveBrandScope = createMerchantBrandScope(options.persistence);
  /**
   * Coordinator 2026-10-31 decision 3: whether this person may open a Store (Brand Owner
   * authority now), so the Stores page offers the form only to them. Anyone else: false.
   */
  const mayOpen = async (input: { readonly sessionCookie: unknown; readonly csrf: unknown }) => {
    const session = await options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const brand = await resolveBrandScope(
          tx,
          input.sessionCookie,
          session.sessionReference,
        ).catch(() => null);
        return (
          brand !== null &&
          (await brand.authorizeAction(storeOpeningPermission))?.effect === "Allow"
        );
      }),
    );
  };
  const open = async (input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
  }) => {
    const command = parseMerchantStoreOpeningCommand(input.command);
    const session = await options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await resolveScope(
          tx,
          input.sessionCookie,
          "merchant.access",
          session.sessionReference,
        ).catch(() => fail("PermissionDenied"));
        if (!(await scope.allowed())) fail("PermissionDenied");
        const brand = await resolveBrandScope(
          tx,
          input.sessionCookie,
          session.sessionReference,
        ).catch(() => null);
        if (
          brand === null ||
          (await brand.authorizeAction(storeOpeningPermission))?.effect !== "Allow"
        )
          fail("PermissionDenied");
        const brandReference = String(scope.context.brand.brandReference),
          fromStore = String(scope.store.storeReference),
          actorReference = String(scope.actorReference);
        const memberships = createPostgresCurrentMembershipSource(tx, scope.context);
        const membership = resolveActiveMembership(
          await memberships.findMemberships(
            scope.actorReference,
            scope.context.brand.brandReference,
          ),
          scope.actorReference,
          scope.context.brand.brandReference,
          scope.context.resolvedAt,
        );
        const result = await recordStoreOpening(tx, {
          command,
          brandReference,
          openedFromStoreReference: fromStore,
          actorReference,
          membershipReference: String(membership.membershipReference),
          openedAt: options.persistence.now(),
        });
        // The opener's permission still holds when the opening commits.
        if (!(await scope.allowed())) fail("PermissionDenied");
        return result;
      }),
    );
  };
  return Object.freeze({ open, mayOpen });
}

/**
 * The opening itself, once the caller confirmed the opener's Brand-level permission and current
 * Membership in this transaction: the Store, the opener's place there (Membership), the audit
 * record and the opening record, under the new Store's scope.
 */
export async function recordStoreOpening(
  tx: unknown,
  input: {
    readonly command: MerchantStoreOpeningCommand;
    readonly brandReference: string;
    readonly openedFromStoreReference: string;
    readonly actorReference: string;
    readonly membershipReference: string;
    readonly openedAt: string;
  },
) {
  const op = input.command.operationReference;
  try {
    return await openStore(
      tx as StoreOpeningTransaction,
      {
        openingReference: op,
        brandReference: input.brandReference,
        openedFromStoreReference: input.openedFromStoreReference,
        actorReference: input.actorReference,
        membershipReference: input.membershipReference,
        storeAssignmentReference: derivedReference(op, "store-opening:assignment"),
        auditReference: derivedReference(op, "store-opening:audit"),
        code: input.command.code,
        displayName: input.command.displayName,
        timeZone: input.command.timeZone,
        locale: input.command.locale,
        openedAt: input.openedAt,
      },
      async (within, request) => {
        await assignMemberToStore(within as unknown as MemberDirectoryTransaction, {
          brandReference: input.brandReference,
          storeReference: request.openingReference,
          actorReference: input.actorReference,
          membershipReference: request.membershipReference,
          storeAssignmentReference: request.storeAssignmentReference,
          at: input.openedAt,
        });
        await appendAuditRecordInTransaction(
          within as unknown as Parameters<typeof appendAuditRecordInTransaction>[0],
          validateAuditRecord({
            auditId: request.auditReference,
            brandId: input.brandReference,
            storeId: request.openingReference,
            actor: { type: "User", reference: input.actorReference },
            actionCode: "STORE_OPENED",
            targetType: "Store",
            targetId: request.openingReference,
            reasonCode: "OWNER_OPENED_STORE",
            correlationId: op,
            occurredAt: input.openedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          }),
        );
      },
    );
  } catch (error) {
    if (error instanceof StoreOpeningError)
      return fail(
        error.code === "CodeTaken"
          ? "CodeTaken"
          : error.code === "Invalid"
            ? "Invalid"
            : "Conflict",
      );
    if (error instanceof MemberDirectoryError) return fail("Conflict");
    throw error;
  }
}
