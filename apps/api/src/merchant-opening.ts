import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { createIdentityActor } from "@bop/identity";
import { addFirstMerchantOwner, type MemberDirectoryTransaction } from "@bop/membership";
import {
  createPostgresMerchantOrganizationSource,
  createTenantContext,
  openMerchant,
  parseBrandReference,
  StoreOpeningError,
  type StoreOpeningTransaction,
} from "@bop/tenant";
import {
  applyCatalogTaxClassificationChange,
  createCategoryMenuService,
  createPostgresMenuDraftStore,
  createPostgresProductTaxClassificationRegistryStore,
  parseCatalogHash,
} from "@rms/catalog";
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
    taxClassificationReference: of("tax-classification"),
    menuReference: of("menu"),
    storeAuditReference: of("store-audit"),
  });
}

/**
 * The first things any merchant's menu needs, in the opening's transaction, under its Owner: one tax
 * class (the Owner renames or adds more on the tax classes page) and one empty menu serving the first
 * Store (the Owner fills it on the Menu page). Their identities derive from the operation, so a guest
 * entry can name the menu before it has dishes.
 */
export async function recordMerchantFirstContent(
  tx: unknown,
  input: {
    readonly command: MerchantOpeningCommand;
    readonly openedAt: string;
  },
) {
  const { command, openedAt: at } = input;
  const references = merchantOpeningReferences(command.operationReference);
  const of = (name: string) =>
    derivedReference(command.operationReference, "merchant-opening:content:" + name);
  const owner = command.ownerActorReference;
  interface Tx { query(sql: string, values: readonly unknown[]): Promise<unknown> }
  const db = tx as Tx;
  const noStore = () =>
    db.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      references.brandReference,
    ]);
  const change = applyCatalogTaxClassificationChange(null, command.locale, {
    kind: "Add",
    entries: [
      {
        classificationReference: references.taxClassificationReference,
        localizedNames: { [command.locale]: "Standard" },
      },
    ],
  });
  if (!change.ok) throw new MerchantOpeningError("Invalid");
  await noStore();
  const pending: { guard: () => Promise<void>; final: () => void }[] = [];
  const registry = createPostgresProductTaxClassificationRegistryStore({
    tenantReference: references.tenantReference,
    brandReference: references.brandReference,
    actorReference: owner,
    actorKind: "User",
    clock: { now: () => at },
    transactions: { run: async (work: (actual: never) => Promise<never>) => work(tx as never) },
    authority: { holdUntilTransactionCompletes: async () => undefined },
    audit: {
      create: (entry: {
        readonly operationReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly registry: { readonly registryReference: string };
        readonly reasonCode: string;
        readonly occurredAt: string;
      }) => ({
        auditId: of("tax-audit"),
        brandId: entry.brandReference,
        actor: { type: "User", reference: entry.actorReference },
        actionCode: "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
        targetType: "CatalogTaxClassificationRegistry",
        targetId: entry.registry.registryReference,
        reasonCode: entry.reasonCode,
        correlationId: entry.operationReference,
        occurredAt: entry.occurredAt,
        sourceChannel: "DEPLOYMENT",
        dataClassification: "Internal",
        retentionPolicyCode: "CATALOG_CONFIGURATION",
        retentionPolicyVersion: 1,
      }),
    },
    async registerBeforeCommit(_actual: unknown, guard: () => Promise<void>, final: () => void) {
      pending.push({ guard, final });
    },
  } as never);
  await registry.execute({
    purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
    tenantReference: references.tenantReference,
    brandReference: references.brandReference,
    actorReference: owner,
    actorKind: "User",
    operationReference: of("tax-operation"),
    reasonCode: "CATALOG_TAX_CLASSIFICATION_ADDED",
    expectedRegistryVersion: 0,
    occurredAt: at,
    registry: {
      profile: "CatalogProductTaxClassificationRegistryV1",
      tenantReference: references.tenantReference,
      brandReference: references.brandReference,
      registryReference: of("tax-registry"),
      versionReference: of("tax-version"),
      registryVersion: 1,
      defaultLocale: command.locale,
      previousSnapshotDigest: null,
      registeredAt: at,
      definitions: change.definitions,
      defaultClassificationReference: change.defaultClassificationReference,
    },
  });
  for (const entry of pending) await entry.guard();
  for (const entry of pending) entry.final();

  // The Owner's Brand scope, as the Menu page's own command runs under it.
  const organizations = createPostgresMerchantOrganizationSource(
    tx as never,
    {
      brandReference: references.brandReference,
      storeReference: references.storeReference,
      observedAt: at,
    } as never,
  );
  const brand = await organizations.getBrand(parseBrandReference(references.brandReference));
  if (brand === null) throw new MerchantOpeningError("Conflict");
  const context = createTenantContext(
    createIdentityActor({
      actorType: "User",
      actorReference: owner,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    brand,
    null,
    at,
  );
  let generated = 0;
  const menus = createCategoryMenuService({
    menus: createPostgresMenuDraftStore({
      brandReference: references.brandReference,
      transactions: { run: (work) => work(tx as never) },
      now: () => at,
      authorize: async () => true,
    }),
    categories: {} as never,
    facts: {
      validateStores: async (value: { readonly storeReferences: readonly string[] }) =>
        value.storeReferences.every((store) => store === references.storeReference),
      validateCategories: async () => true,
      validateSellables: async () => true,
    },
    references: {
      generate: (kind: string) =>
        kind === "Menu" ? references.menuReference : of("menu:" + kind + ":" + generated++),
      hashIntent: (value: string) =>
        parseCatalogHash(createHash("sha256").update(value).digest("hex")),
      equals: (a: unknown, b: unknown) => a === b,
    },
    authorization: {
      authorize: async (request: {
        readonly action: string;
        readonly aggregateReference: string;
        readonly observedAt: string;
      }) => {
        await noStore();
        return {
          tenantContext: context,
          permission: { effect: "Allow", scopeKind: "Brand", action: "catalog.menu.manage" },
          audit: {
            auditId: of("menu-audit"),
            brandId: references.brandReference,
            actor: { type: "User", reference: owner },
            actionCode: "CATALOG_MENU_" + request.action.toUpperCase(),
            targetType: "CatalogMenu",
            targetId: request.aggregateReference,
            correlationId: command.operationReference,
            occurredAt: request.observedAt,
            reasonCode: "MERCHANT_OPENED",
            sourceChannel: "DEPLOYMENT",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          },
        };
      },
    },
  } as never);
  await menus.createMenu({
    internalCode: "MAIN",
    draft: {
      defaultLocale: command.locale,
      localizedNames: { [command.locale]: "Menu" },
      baseMenuReference: null,
      storeReferences: [references.storeReference],
      channelCodes: ["CUSTOMER_PWA"],
      orderTypeCodes: ["PICKUP", "DINE_IN"],
      sections: [],
    },
    operationReference: of("menu-operation"),
    requestedAt: at,
  });
  return Object.freeze({
    taxClassificationReference: references.taxClassificationReference,
    menuReference: references.menuReference,
  });
}
