import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import type { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  productCreateWriteFields,
  productCreateResultFields,
  productDraftWriteFields,
  productDraftResultFields,
  MerchantProductWriteFeatureDisabled,
  type MerchantProductWriteAuthority,
  type ProductWriteIntent,
} from "./merchant-product-write-authority.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Transaction = Parameters<Host["registerBeforeCommit"]>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** Fixed server authoring admission. Owning content/reference validation is
 * separate; this holder grants neither publication eligibility nor facts. */
export function createMerchantProductAuthoringRuntimeAuthority(options: {
  readonly transaction: Transaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly intent: ProductWriteIntent;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly currentAuthorization: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  readonly capability: ReturnType<typeof createMerchantProductStoreCapabilityGuard>;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
}) {
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    authorize = options.currentAuthorization.authorizeActions.bind(options.currentAuthorization),
    assertAuthorization = options.currentAuthorization.assertCurrent.bind(
      options.currentAuthorization,
    ),
    holdCapability = options.capability.holdUntilCommit.bind(options.capability),
    register = options.registerBeforeCommit.bind(options),
    startedAt = parseCatalogInstant(now()),
    deadline = parseCatalogInstant(options.originalValidUntil),
    identity = Object.freeze({
      tenantReference: parseCatalogReference(options.tenantReference),
      brandReference: parseCatalogReference(options.brandReference),
      storeReference: parseCatalogReference(options.storeReference),
      actorReference: parseCatalogReference(options.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
      productReference: parseCatalogReference(options.productReference),
      operationReference: parseCatalogReference(options.operationReference),
    }),
    rawIntent = copyCategoryPersistenceValue(options.intent);
  if (deadline <= startedAt || Date.parse(deadline) - Date.parse(startedAt) > 5000) return fail();
  const intent = readClosedRecord(
    rawIntent,
    (rawIntent as Record<string, unknown>)?.action === "Create"
      ? ["action", "expectedAggregateVersion", "createsSkus"]
      : ["action", "expectedAggregateVersion"],
  );
  if (
    intent.action === "Create"
      ? intent.expectedAggregateVersion !== null || typeof intent.createsSkus !== "boolean"
      : intent.action !== "ReplaceDraft" ||
        !Number.isSafeInteger(intent.expectedAggregateVersion) ||
        (intent.expectedAggregateVersion as number) < 1 ||
        (intent.expectedAggregateVersion as number) >= 2147483647
  )
    return fail();
  const parent = Object.freeze({
    ...identity,
    permission: "catalog.manage",
    owningAction: "catalog.product.manage",
    phase: "phase_1",
    ...(intent.action === "Create"
      ? {
          action: "Create",
          actionPermission: "catalog.product.create",
          skuCreationPermission: intent.createsSkus ? "catalog.sku.create" : null,
          screenId: "CAT-PRODUCT-CREATE",
          capability: "catalog.cat_product_create",
          purposeCode: "CATALOG_PRODUCT_CREATE",
          expectedAggregateVersion: null,
          requiredWriteFields: productCreateWriteFields,
          requiredReadFields: productCreateResultFields,
        }
      : {
          action: "ReplaceDraft",
          actionPermission: "catalog.product.update",
          screenId: "CAT-PRODUCT-EDIT",
          capability: "catalog.cat_product_edit",
          purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE",
          expectedAggregateVersion: intent.expectedAggregateVersion,
          requiredWriteFields: productDraftWriteFields,
          requiredReadFields: productDraftResultFields,
        }),
  });
  let latest = startedAt,
    failed = false,
    active = false,
    registered = false,
    guardRan = false,
    finalized = false,
    skuIntent: {
      createdSkuReferences: readonly string[];
      updatedSkuReferences: readonly string[];
    } | null = null;
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (
      error instanceof MerchantProductWriteFeatureDisabled ||
      (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
    )
      throw error;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || at < latest || at >= deadline) return poison();
      assertAuthorization();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const current = async () => {
    check();
    if (active || finalized) return poison();
    active = true;
    try {
      await holdCapability();
      check();
      // Restore Brand authorization after the capability's selected Store read.
      const actions = ["catalog.manage", "catalog.product.manage", parent.actionPermission];
      if (intent.action === "Create" ? intent.createsSkus : skuIntent?.createdSkuReferences.length)
        actions.push("catalog.sku.create");
      if (skuIntent?.updatedSkuReferences.length) actions.push("catalog.sku.update");
      if ((await authorize(Object.freeze(actions))) !== undefined) return poison();
      check();
    } catch (error) {
      return reject(error);
    } finally {
      active = false;
    }
  };
  const writeAuthority: MerchantProductWriteAuthority = async (actual, value) => {
    try {
      check();
      if (actual !== tx || active || finalized) return poison();
      const fields = [
          ...Object.keys(parent),
          "observedAt",
          ...(intent.action === "ReplaceDraft" ? ["skuDraftIntent"] : []),
        ],
        input = readClosedRecord(copyCategoryPersistenceValue(value), fields),
        at = parseCatalogInstant(input.observedAt);
      if (at < startedAt || at > check()) return poison();
      for (const key of Object.keys(parent) as (keyof typeof parent)[])
        if (!equal(input[key], parent[key])) return poison();
      if (intent.action === "ReplaceDraft") {
        if (input.skuDraftIntent === null) {
          if (skuIntent !== null) return poison();
        } else {
          const raw = readClosedRecord(input.skuDraftIntent, [
            "createdSkuReferences",
            "updatedSkuReferences",
          ]);
          const refs = (value: unknown) => {
            if (!Array.isArray(value) || value.length > 10000) return poison();
            const parsed = value.map(parseCatalogReference);
            if (new Set(parsed).size !== parsed.length) return poison();
            return Object.freeze(parsed.sort());
          };
          const candidate = Object.freeze({
            createdSkuReferences: refs(raw.createdSkuReferences),
            updatedSkuReferences: refs(raw.updatedSkuReferences),
          });
          if (
            candidate.createdSkuReferences.some((ref) =>
              candidate.updatedSkuReferences.includes(ref),
            )
          )
            return poison();
          if (skuIntent !== null && !equal(candidate, skuIntent)) return poison();
          skuIntent = candidate;
        }
      }
      await current();
      if (!registered) {
        registered = true;
        if (
          (await register(
            tx,
            async () => {
              if (guardRan || (intent.action === "ReplaceDraft" && skuIntent === null))
                return poison();
              guardRan = true;
              await current();
            },
            () => {
              check();
              if (!guardRan || active || finalized) return poison();
              finalized = true;
            },
          )) !== undefined
        )
          return poison();
        check();
      }
      return "Allowed";
    } catch (error) {
      return reject(error);
    }
  };
  return Object.freeze({ writeAuthority, assertCurrent: check });
}
