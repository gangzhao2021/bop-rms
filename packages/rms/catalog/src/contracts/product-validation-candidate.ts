import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseProductAggregate } from "./product.js";
import { parseProductPublicationCommand } from "./product-publication.js";
import { deriveCatalogProductPublicationContentIdentity } from "./product-publication-content.js";
import { productEditorContentFields } from "../application/product-editor-content-authority.js";
export const productValidationCandidateFields = Object.freeze([
  "productReference",
  "brandReference",
  "internalCode",
  "productType",
  "lifecycle",
  "aggregateVersion",
  "createdAt",
  "createdByActorReference",
  "updatedAt",
  "draft",
  "localizedNames",
  "taxClassificationReference",
  "skus",
  "optionBindings",
  "categoryClassification",
  ...productEditorContentFields,
] as const);
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Binding only. Actual current provenance and held authority belong to the owner. */
export function bindCatalogProductValidationCandidate(
  commandValue: unknown,
  aggregateValue: unknown,
  observedAtValue: unknown,
) {
  const c = parseProductPublicationCommand(commandValue),
    aggregate = parseProductAggregate(copyCategoryPersistenceValue(aggregateValue)),
    observedAt = parseCatalogInstant(observedAtValue),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  if (
    c.action !== "Validate" ||
    c.actorKind !== "User" ||
    c.occurredAt > observedAt ||
    aggregate.updatedAt > observedAt ||
    aggregate.draft.updatedAt > observedAt ||
    aggregate.brandReference !== c.brandReference ||
    aggregate.productReference !== c.productReference ||
    aggregate.draft.versionReference !== c.versionReference ||
    aggregate.aggregateVersion !== c.expectedProductAggregateVersion ||
    identity.contentDigest !== c.contentDigest ||
    identity.configurationDigest !== c.configurationDigest
  )
    return fail();
  return Object.freeze({
    profile: "CatalogProductValidationCandidateV1" as const,
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    actorReference: c.actorReference,
    aggregate,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    originalIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(c)),
    observedAt,
    validUntil: parseCatalogInstant(new Date(Date.parse(observedAt) + 30000).toISOString()),
    completeContent:
      aggregate.draft.editorContent === undefined ? ("Unavailable" as const) : ("Present" as const),
    // Necessary owning membership only; no supported type declares a SKU waiver.
    // Active membership does not establish target-scope publishability or sale.
    skuPrerequisite: aggregate.draft.skus.some((sku) => sku.lifecycle === "Active")
      ? ("ActiveMemberPresent" as const)
      : ("NoActiveMember" as const),
    // Explicit pending combinations only. Absence cannot certify full mapping.
    variantMappingPrerequisite:
      aggregate.draft.editorContent === undefined
        ? ("Unavailable" as const)
        : aggregate.draft.editorContent.variantCombinations.some(
              (combination) => combination.disposition === "NotGenerated",
            )
          ? ("UnmappedCombinationPresent" as const)
          : ("NoExplicitUnmappedCombination" as const),
    // Exact explicit defaults only; absent bounds require independent sources.
    optionSelectionPrerequisite:
      aggregate.draft.editorContent === undefined
        ? ("Unavailable" as const)
        : aggregate.draft.optionBindings.some((binding) => {
              const total = binding.defaultSelections.reduce(
                (sum, selection) => sum + BigInt(selection.quantity),
                0n,
              );
              return (
                (binding.minimumSelectionOverride !== null &&
                  total < BigInt(binding.minimumSelectionOverride)) ||
                (binding.maximumSelectionOverride !== null &&
                  total > BigInt(binding.maximumSelectionOverride))
              );
            })
          ? ("ExplicitDefaultBoundsViolated" as const)
          : ("NoExplicitDefaultBoundsViolation" as const),
    publicationHead: "NotEvaluated" as const,
    referenceEligibility: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    eligibility: "NotEvaluated" as const,
  });
}
export type CatalogProductValidationCandidate = ReturnType<
  typeof bindCatalogProductValidationCandidate
>;
/** Only the owning current persistence source supplies this check. Pure content
 * binding cannot establish Brand code uniqueness. No full validation implied. */
export type CatalogCurrentProductValidationCandidate = CatalogProductValidationCandidate & {
  readonly internalCodeCheck: {
    readonly code: "InternalCode";
    readonly outcome: "Pass" | "HardError";
  };
};
