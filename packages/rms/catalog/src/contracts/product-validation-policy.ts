import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogReference } from "./product.js";
import { parseProductPublicationValidation } from "./product-publication.js";

/** Pure owner binding. Current acquisition, authority and original lease remain
 * mandatory in the consumer; this function never creates a validation outcome. */
export function bindCatalogProductValidationToPolicy(
  validationValue: unknown,
  policyValue: unknown,
  contextValue: unknown,
) {
  try {
    const validation = parseProductPublicationValidation(validationValue),
      policy = parsePublishingProductPublicationPolicy(policyValue),
      context = copyCategoryPersistenceValue(contextValue) as Record<string, unknown>;
    if (
      !context ||
      typeof context !== "object" ||
      Array.isArray(context) ||
      Object.keys(context).length !== 2 ||
      !Object.hasOwn(context, "tenantReference") ||
      !Object.hasOwn(context, "brandReference")
    )
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    if (
      (policy.tenantReference as string) !== parseCatalogReference(context.tenantReference) ||
      (policy.brandReference as string) !== parseCatalogReference(context.brandReference) ||
      policy.policyReference !== validation.policyReference ||
      policy.policyVersion !== validation.policyVersion ||
      policy.approvalPolicy !== validation.approvalPolicy ||
      (validation.warningAcknowledgement !== null && !policy.warningOverrideAllowed)
    )
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    return validation;
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
