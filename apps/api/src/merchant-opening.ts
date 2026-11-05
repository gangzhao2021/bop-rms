import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { addFirstMerchantOwner, type MemberDirectoryTransaction } from "@bop/membership";
import { openMerchant, StoreOpeningError, type StoreOpeningTransaction } from "@bop/tenant";
import { derivedReference } from "./merchant-products.js";

export class MerchantOpeningError extends Error {
  constructor(readonly code: "Invalid" | "CodeTaken" | "Conflict") {
    super("MERCHANT_OPENING_" + code.toUpperCase());
    this.name = "MerchantOpeningError";
  }
}
export interface MerchantOpeningCommand {
  readonly operationReference: string;
  readonly ownerActorReference: string;
  readonly brandCode: string;
  readonly brandName: string;
  readonly storeCode: string;
  readonly storeName: string;
  readonly timeZone: string;
  readonly locale: string;
}

/**
 * WP-2423 DEC-MULTI-MERCHANT-ONE-INSTALLATION A6: a new merchant, once the caller confirmed who may
 * open one: its Brand, first Store and Owner's place there, with audit records under whoever opened
 * it, in the caller's transaction. Everything's identity derives from the operation, so a retry
 * finds its own result. Roles, configuration, go-live check and menu follow in their own steps, and
 * guests order there only once it is live.
 */
export async function recordMerchantOpening(
  tx: unknown,
  input: {
    readonly command: MerchantOpeningCommand;
    readonly openedByActorReference: string;
    readonly sourceChannel: string;
    readonly openedAt: string;
  },
) {
  const { command, openedAt } = input;
  const op = command.operationReference;
  const references = merchantOpeningReferences(op);
  const audit = (
    within: StoreOpeningTransaction,
    entry: {
      readonly auditId: string;
      readonly storeId?: string;
      readonly actionCode: string;
      readonly targetType: string;
      readonly targetId: string;
    },
  ) =>
    appendAuditRecordInTransaction(
      within as unknown as Parameters<typeof appendAuditRecordInTransaction>[0],
      validateAuditRecord({
        ...entry,
        brandId: references.brandReference,
        actor: { type: "User", reference: input.openedByActorReference },
        reasonCode: "MERCHANT_OPENED",
        correlationId: op,
        occurredAt: openedAt,
        sourceChannel: input.sourceChannel,
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    );
  try {
    const result = await openMerchant(
      tx as StoreOpeningTransaction,
      {
        openingReference: references.storeReference,
        brandReference: references.brandReference,
        actorReference: command.ownerActorReference,
        membershipReference: references.membershipReference,
        storeAssignmentReference: references.storeAssignmentReference,
        auditReference: references.storeAuditReference,
        brandCode: command.brandCode,
        brandName: command.brandName,
        code: command.storeCode,
        displayName: command.storeName,
        timeZone: command.timeZone,
        locale: command.locale,
        openedAt,
      },
      {
        withinBrand: async (within) => {
          await audit(within, {
            auditId: references.brandAuditReference,
            actionCode: "BRAND_CREATED",
            targetType: "Brand",
            targetId: references.brandReference,
          });
        },
        withinStore: async (within) => {
          await addFirstMerchantOwner(within as unknown as MemberDirectoryTransaction, {
            brandReference: references.brandReference,
            storeReference: references.storeReference,
            actorReference: command.ownerActorReference,
            membershipReference: references.membershipReference,
            storeAssignmentReference: references.storeAssignmentReference,
            openingReference: op,
            at: openedAt,
          });
          await audit(within, {
            auditId: references.storeAuditReference,
            storeId: references.storeReference,
            actionCode: "STORE_OPENED",
            targetType: "Store",
            targetId: references.storeReference,
          });
        },
      },
    );
    return Object.freeze({ ...references, status: result.status });
  } catch (error) {
    if (error instanceof StoreOpeningError) {
      if (error.code === "Unavailable") throw error;
      throw new MerchantOpeningError(error.code);
    }
    throw error;
  }
}
export function merchantOpeningReferences(operationReference: string) {
  const of = (name: string) => derivedReference(operationReference, "merchant-opening:" + name);
  return Object.freeze({
    tenantReference: of("tenant"),
    brandReference: of("brand"),
    storeReference: of("store"),
    membershipReference: of("membership"),
    storeAssignmentReference: of("assignment"),
    brandAuditReference: of("brand-audit"),
    storeAuditReference: of("store-audit"),
  });
}
