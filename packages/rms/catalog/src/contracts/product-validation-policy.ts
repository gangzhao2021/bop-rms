import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogReference } from "./product.js";
import {
  parseProductPublicationValidation,
  type ProductPublicationValidation,
} from "./product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  type ProductPublicationValidationV2,
} from "./product-publication-v2.js";

/** Pure owner binding. Current acquisition, authority and original lease remain
 * mandatory in the consumer; this function never creates a validation outcome. */
export function bindCatalogProductValidationToPolicy(
  validationValue: unknown,
  policyValue: unknown,
  contextValue: unknown,
) {
  try {
    return bindValidation(
      parseProductPublicationValidation(validationValue),
      policyValue,
      contextValue,
    );
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
/** Explicit V2 command/evidence binding. This does not establish current policy
 * acquisition or alter any independent validation outcome or original deadline. */
export function bindCatalogProductValidationToPolicyV2(
  commandValue: unknown,
  validationValue: unknown,
  policyValue: unknown,
) {
  try {
    const c = parseProductPublicationCommandV2(commandValue),
      v = parseProductPublicationValidationV2(validationValue),
      hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
    if (
      v.replacementIntentDigest !== c.replacementIntentDigest ||
      v.productAggregateVersion !== c.expectedProductAggregateVersion ||
      v.contentDigest !== c.contentDigest ||
      v.configurationDigest !== c.configurationDigest ||
      v.scopeDigest !== hash(c.scopeSet) ||
      v.periodDigest !== hash(c.effectivePeriod)
    )
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    return bindValidation(v, policyValue, {
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
// The public entry points select fixed parsers. V2 evidence is never projected
// through the closed V1 binder and its target digest remains on the result.
function bindValidation<V extends ProductPublicationValidation | ProductPublicationValidationV2>(
  validation: V,
  policyValue: unknown,
  contextValue: unknown,
): V {
  const policy = parsePublishingProductPublicationPolicy(policyValue),
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
}
