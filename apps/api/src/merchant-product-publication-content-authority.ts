import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  parseProductPublicationCommand,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  type ProductEditorContentAuthority,
} from "@rms/catalog";
import type { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";

type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantBrandScope>>>;
type Tx = Parameters<ProductEditorContentAuthority["holdUntilTransactionCompletes"]>[0];
type OwnerInput = Parameters<ProductEditorContentAuthority["holdUntilTransactionCompletes"]>[1];
export type MerchantProductPublicationContentAuthorityInput = OwnerInput & {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly permission: "catalog.manage";
  readonly owningAction: "catalog.product.read";
  readonly purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION";
  readonly command: ReturnType<typeof parseProductPublicationCommand>;
  readonly observedAt: string;
  readonly validUntil: string;
};
/** Server-configured current complete-field and owning reference holder. Missing
 * Media/Option/Safety/Nutrition/policy sources must refuse, never infer readiness.
 */
export type MerchantProductPublicationContentAuthority = (
  tx: Tx,
  input: MerchantProductPublicationContentAuthorityInput,
) => Promise<void>;

/** Adapts owning Read/Publish leases into the existing outer Merchant UoW.
 * No SQL, business-reference resolution, permission grant or browser DTO here.
 */
export function createMerchantProductPublicationContentAuthority(options: {
  readonly transaction: Tx;
  readonly scope: Scope;
  readonly sessionReference: string;
  readonly command: MerchantProductPublicationContentAuthorityInput["command"];
  readonly authority: MerchantProductPublicationContentAuthority;
  readonly now: () => string;
  readonly registerBeforeCommit: ReturnType<
    typeof createMerchantCategoryTransactions
  >["registerBeforeCommit"];
}): ProductEditorContentAuthority & { assertCurrent(): void } {
  const unavailable = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const transaction = options.transaction,
    query = transaction.query,
    command = parseProductPublicationCommand(copyCategoryPersistenceValue(options.command)),
    hold = options.authority?.bind(options),
    now = options.now?.bind(options),
    authorize = options.scope.authorizeAction.bind(options.scope),
    register = options.registerBeforeCommit.bind(options);
  if (typeof hold !== "function" || typeof now !== "function") return unavailable();
  let observedAt: string,
    bound: Omit<MerchantProductPublicationContentAuthorityInput, keyof OwnerInput>;
  try {
    observedAt = parseCatalogInstant(now());
    bound = Object.freeze({
      tenantReference: parseCatalogReference(options.scope.tenantReference),
      brandReference: parseCatalogReference(options.scope.context.brand.brandReference),
      storeReference: parseCatalogReference(options.scope.selectedStoreReference),
      actorReference: parseCatalogReference(options.scope.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
      productReference: parseCatalogReference(command.productReference),
      operationReference: parseCatalogReference(command.operationReference),
      permission: "catalog.manage",
      owningAction: "catalog.product.read",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      command,
      observedAt,
      validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
    });
  } catch {
    return unavailable();
  }
  if (
    command.tenantReference !== bound.tenantReference ||
    command.brandReference !== bound.brandReference ||
    command.actorKind !== "User" ||
    command.actorReference !== bound.actorReference ||
    command.purposeCode !== bound.purposeCode ||
    command.action === "ActivateScheduled"
  )
    return unavailable();
  let failed = false,
    registered = false;
  const admitted = new Map<string, MerchantProductPublicationContentAuthorityInput>();
  let latest = observedAt;
  const check = () => {
    const current = parseCatalogInstant(now());
    if (failed || transaction.query !== query || current < latest || current >= bound.validUntil)
      return unavailable();
    latest = current;
  };
  const native = async () => {
    check();
    for (const action of ["catalog.manage", "catalog.product.read", "catalog.sku.read"]) {
      check();
      const decision = await authorize(action);
      check();
      if (
        decision?.effect !== "Allow" ||
        decision.action !== action ||
        decision.scopeKind !== "Brand"
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }
  };
  const recheck = async (input: MerchantProductPublicationContentAuthorityInput) => {
    await native();
    // Reassert exact original fields/references without acquiring new facts or renewing expiry.
    if ((await hold(transaction, input)) !== undefined) return unavailable();
    check();
    await native();
  };
  return Object.freeze({
    assertCurrent: check,
    async holdUntilTransactionCompletes(tx: Tx, request: OwnerInput) {
      try {
        check();
        const safe = readClosedRecord(copyCategoryPersistenceValue(request), [
          "mode",
          "aggregate",
          "requiredFields",
          "requiredReferenceChecks",
        ]);
        if (
          tx !== transaction ||
          !["Read", "Publish"].includes(safe.mode as string) ||
          JSON.stringify(safe.requiredFields) !== JSON.stringify(productEditorContentFields) ||
          JSON.stringify(safe.requiredReferenceChecks) !==
            JSON.stringify(safe.mode === "Read" ? [] : productEditorContentReferenceChecks)
        )
          return unavailable();
        const aggregate = parseProductAggregate(safe.aggregate);
        if (
          aggregate.brandReference !== bound.brandReference ||
          aggregate.productReference !== bound.productReference ||
          aggregate.draft.editorContent === undefined ||
          Buffer.byteLength(JSON.stringify(aggregate), "utf8") > 8 * 1024 * 1024
        )
          return unavailable();
        const input = Object.freeze({
          ...bound,
          mode: safe.mode as "Read" | "Publish",
          aggregate,
          requiredFields: productEditorContentFields,
          requiredReferenceChecks:
            safe.mode === "Read" ? Object.freeze([]) : productEditorContentReferenceChecks,
        });
        const key = safe.mode + ":" + JSON.stringify(aggregate);
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
              if (
                error instanceof CatalogError &&
                ["CATALOG_PERMISSION_DENIED", "CATALOG_DEPENDENCY_UNAVAILABLE"].includes(error.code)
              )
                throw error;
              return unavailable();
            }
          });
        }
      } catch (error) {
        failed = true;
        if (
          error instanceof CatalogError &&
          ["CATALOG_PERMISSION_DENIED", "CATALOG_DEPENDENCY_UNAVAILABLE"].includes(error.code)
        )
          throw error;
        return unavailable();
      }
    },
  });
}
