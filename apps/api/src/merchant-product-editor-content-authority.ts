import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  type ProductEditorContentAuthority,
} from "@rms/catalog";
import type { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";

type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantBrandScope>>>;
type Tx = Parameters<ProductEditorContentAuthority["holdUntilTransactionCompletes"]>[0];
type OwnerInput = Parameters<ProductEditorContentAuthority["holdUntilTransactionCompletes"]>[1];
export type MerchantProductEditorContentAuthorityInput = OwnerInput & {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly permission: "catalog.manage";
  readonly owningAction: "catalog.product.manage";
  readonly purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" | "CATALOG_PRODUCT_CREATE";
  readonly observedAt: string;
  readonly validUntil: string;
};
/** Server-configured current complete-field and owning reference holder. Missing
 * Media/Option/Safety/Nutrition/policy sources must refuse, never infer readiness.
 */
export type MerchantProductEditorContentAuthority = (
  tx: Tx,
  input: MerchantProductEditorContentAuthorityInput,
) => Promise<void>;

/** Adapts owning Read/DraftWrite leases into the existing outer Merchant UoW.
 * No SQL, business-reference resolution, permission grant or browser DTO here.
 */
export function createMerchantProductEditorContentAuthority(options: {
  readonly transaction: Tx;
  readonly scope: Scope;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly authority: MerchantProductEditorContentAuthority;
  readonly purposeCode?: MerchantProductEditorContentAuthorityInput["purposeCode"];
  readonly now: () => string;
  readonly registerBeforeCommit: ReturnType<
    typeof createMerchantCategoryTransactions
  >["registerBeforeCommit"];
}): ProductEditorContentAuthority & { assertCurrent(): void } {
  const unavailable = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const transaction = options.transaction,
    hold = options.authority?.bind(options),
    now = options.now?.bind(options),
    authorize = options.scope.authorizeAction.bind(options.scope),
    register = options.registerBeforeCommit.bind(options);
  if (typeof hold !== "function" || typeof now !== "function") return unavailable();
  let observedAt: string, bound: Omit<MerchantProductEditorContentAuthorityInput, keyof OwnerInput>;
  try {
    observedAt = parseCatalogInstant(now());
    bound = Object.freeze({
      tenantReference: parseCatalogReference(options.scope.tenantReference),
      brandReference: parseCatalogReference(options.scope.context.brand.brandReference),
      storeReference: parseCatalogReference(options.scope.selectedStoreReference),
      actorReference: parseCatalogReference(options.scope.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
      productReference: parseCatalogReference(options.productReference),
      operationReference: parseCatalogReference(options.operationReference),
      permission: "catalog.manage",
      owningAction: "catalog.product.manage",
      purposeCode: options.purposeCode ?? "CATALOG_PRODUCT_DRAFT_REPLACE",
      observedAt,
      validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
    });
  } catch {
    return unavailable();
  }
  if (!["CATALOG_PRODUCT_DRAFT_REPLACE", "CATALOG_PRODUCT_CREATE"].includes(bound.purposeCode))
    return unavailable();
  let failed = false,
    registered = false;
  const admitted = new Map<string, MerchantProductEditorContentAuthorityInput>();
  const check = () => {
    const current = parseCatalogInstant(now());
    if (failed || current < observedAt || current >= bound.validUntil) return unavailable();
  };
  const recheck = async (input: MerchantProductEditorContentAuthorityInput) => {
    check();
    for (const action of ["catalog.product.read", "catalog.sku.read"]) {
      const decision = await authorize(action);
      if (
        decision?.effect !== "Allow" ||
        decision.action !== action ||
        decision.scopeKind !== "Brand"
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }
    // A configured holder must hold the original complete-field/reference lease.
    if ((await hold(transaction, input)) !== undefined) return unavailable();
    check();
  };
  return Object.freeze({
    assertCurrent: check,
    async holdUntilTransactionCompletes(tx: Tx, request: OwnerInput) {
      try {
        check();
        if (
          tx !== transaction ||
          !["Read", "DraftWrite"].includes(request.mode) ||
          JSON.stringify(request.requiredFields) !== JSON.stringify(productEditorContentFields) ||
          JSON.stringify(request.requiredReferenceChecks) !==
            JSON.stringify(request.mode === "Read" ? [] : productEditorContentReferenceChecks)
        )
          return unavailable();
        const aggregate = parseProductAggregate(request.aggregate);
        if (
          aggregate.brandReference !== bound.brandReference ||
          aggregate.productReference !== bound.productReference ||
          (bound.purposeCode === "CATALOG_PRODUCT_CREATE" && aggregate.aggregateVersion !== 1) ||
          aggregate.draft.editorContent === undefined ||
          Buffer.byteLength(JSON.stringify(aggregate), "utf8") > 8 * 1024 * 1024
        )
          return unavailable();
        const input = Object.freeze({
          ...bound,
          mode: request.mode,
          aggregate,
          requiredFields: productEditorContentFields,
          requiredReferenceChecks:
            request.mode === "Read" ? Object.freeze([]) : productEditorContentReferenceChecks,
        });
        const key = request.mode + ":" + JSON.stringify(aggregate);
        if (!admitted.has(key) && admitted.size >= 16) return unavailable();
        await recheck(input);
        admitted.set(key, input);
        if (!registered) {
          registered = true;
          await register(tx, async () => {
            try {
              check();
              for (const input of admitted.values()) await recheck(input);
              check();
            } catch (error) {
              failed = true;
              if (error instanceof CatalogError) throw error;
              return unavailable();
            }
          });
        }
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return unavailable();
      }
    },
  });
}
