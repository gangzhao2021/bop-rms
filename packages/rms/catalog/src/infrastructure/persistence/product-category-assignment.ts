import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
  type ProductAggregate,
} from "../../contracts/product.js";
import {
  validateProductCategoryClassification,
  type ProductCategoryAssignmentPolicy,
  type ProductCategoryReferenceFact,
} from "../../domain/product-category.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { holdCategorySourceBarrier, requireCategoryCurrentReads } from "./category-repository.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";
export interface ProductCategoryAssignmentAuthority {
  holdUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly mode: "Read" | "Write";
      readonly aggregate: ProductAggregate;
    },
  ): Promise<void>;
}
export const productCategoryAssignmentFields = Object.freeze([
  "categoryClassification",
  "categoryReferences",
  "primaryCategoryReference",
] as const);
export function createPostgresProductCategoryAssignmentAuthority(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  holdPolicyUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly productReference: string;
      readonly productVersionReference: string;
      readonly purposeCode: "CATALOG_PRODUCT_CATEGORY_ACCESS" | "CATALOG_PRODUCT_CATEGORY_MUTATION";
      readonly permission: "catalog.product.manage";
      readonly referencedPermission: "catalog.manage";
      readonly requiredFields: typeof productCategoryAssignmentFields;
      readonly referencedFields: readonly ["categoryReference", "brandReference", "lifecycle"];
      readonly observedAt: string;
    },
  ): Promise<ProductCategoryAssignmentPolicy>;
}): ProductCategoryAssignmentAuthority {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (typeof options.holdPolicyUntilTransactionCompletes !== "function")
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return Object.freeze<ProductCategoryAssignmentAuthority>({
    async holdUntilTransactionCompletes(tx, input) {
      try {
        const copiedInput = copyCategoryPersistenceValue(input) as Record<string, unknown>;
        if (
          !copiedInput ||
          Array.isArray(copiedInput) ||
          Object.keys(copiedInput).length !== 2 ||
          !Object.hasOwn(copiedInput, "mode") ||
          !Object.hasOwn(copiedInput, "aggregate")
        )
          throw new CatalogError("CATALOG_INPUT_INVALID");
        const mode = copiedInput.mode;
        const aggregate = parseProductAggregate(copiedInput.aggregate),
          classification = aggregate.draft.categoryClassification;
        const at = parseCatalogInstant(options.clock.now());
        if (
          (mode !== "Read" && mode !== "Write") ||
          aggregate.brandReference !== brand ||
          aggregate.updatedAt > at ||
          classification === undefined
        )
          throw new CatalogError("CATALOG_INPUT_INVALID");
        const policy = await options.holdPolicyUntilTransactionCompletes(
          tx,
          Object.freeze({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            productReference: aggregate.productReference,
            productVersionReference: aggregate.draft.versionReference,
            purposeCode:
              mode === "Write"
                ? "CATALOG_PRODUCT_CATEGORY_MUTATION"
                : "CATALOG_PRODUCT_CATEGORY_ACCESS",
            permission: "catalog.product.manage",
            referencedPermission: "catalog.manage",
            requiredFields: productCategoryAssignmentFields,
            referencedFields: Object.freeze([
              "categoryReference",
              "brandReference",
              "lifecycle",
            ] as const),
            observedAt: at,
          }),
        );
        // Validate mandatory policy shape without redoing original business validation on replay/read.
        validateProductCategoryClassification(
          { categoryReferences: [], primaryCategoryReference: null },
          { brandReference: brand, categories: [], policy },
        );
        await requireCategoryCurrentReads(tx);
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [brand],
        );
        if (mode === "Read") return;
        // Product source barrier is already held by every caller. Preserve this lock order.
        await holdCategorySourceBarrier(tx, brand);
        const result = await tx.query(
          "SELECT category_id category_reference,brand_id brand_reference,lifecycle FROM rms_catalog.category WHERE brand_id=$1 AND category_id=ANY($2::uuid[]) ORDER BY category_id FOR SHARE",
          [brand, classification.categoryReferences],
        );
        const d = Object.getOwnPropertyDescriptor(result, "rows");
        if (
          !d ||
          !("value" in d) ||
          !Array.isArray(d.value) ||
          d.value.length !== classification.categoryReferences.length
        )
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        const copiedRows = copyCategoryPersistenceValue(d.value) as Record<string, unknown>[];
        if (
          copiedRows.some(
            (row) =>
              !row ||
              Array.isArray(row) ||
              Object.keys(row).length !== 3 ||
              !["category_reference", "brand_reference", "lifecycle"].every((key) =>
                Object.hasOwn(row, key),
              ),
          )
        )
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        const facts: ProductCategoryReferenceFact[] = copiedRows.map(
          (row: Record<string, unknown>) => ({
            categoryReference: parseCatalogReference(row.category_reference),
            brandReference: parseCatalogReference(row.brand_reference),
            lifecycle: row.lifecycle as ProductCategoryReferenceFact["lifecycle"],
          }),
        );
        validateProductCategoryClassification(classification, {
          brandReference: brand,
          categories: facts,
          policy,
        });
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
