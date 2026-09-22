import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingDigest } from "@bop/publishing";
import { parseMenuAggregate, type MenuAggregate } from "../contracts/category-menu.js";
import {
  CatalogError,
  parseLocalizedNames,
  parseProductLifecycle,
  type CatalogReference,
  type ProductLifecycle,
} from "../contracts/product.js";
import {
  validateMenuAllergenProvenance,
  type MenuAllergenProvenanceSnapshot,
} from "../contracts/allergen-provenance.js";
import {
  parseReviewedMenuContent,
  type PublishedOptionRule,
} from "../contracts/published-menu-projection.js";

export interface MenuReviewSellableFact {
  readonly brandReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly productVersionReference: CatalogReference;
  readonly productLifecycle: ProductLifecycle;
  readonly skuLifecycle: ProductLifecycle;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly optionRules: readonly PublishedOptionRule[];
}

/** Assemble owned current facts; never accept a caller-authored display snapshot.
 * Provenance paths must already come from their trusted owner. Coverage/version
 * checks here cannot establish Recipe/Ingredient linkage or grant approval.
 * The caller must retain source read fences through the eventual review write.
 */
export function buildReviewedMenuContent(input: {
  menu: MenuAggregate;
  sellables: readonly MenuReviewSellableFact[];
  provenance: Omit<MenuAllergenProvenanceSnapshot, "snapshotDigest">;
  checkedAt: string;
  validationEvidenceReference: string;
}) {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const menu = parseMenuAggregate(input.menu);
  const required = new Set(
    menu.draft.sections.flatMap((section) =>
      section.placements.map((placement) => placement.sellableReference),
    ),
  );
  const facts = new Map(input.sellables.map((fact) => [fact.sellableReference, fact]));
  const paths = new Map(input.provenance.paths.map((path) => [path.sellableReference, path]));
  if (
    facts.size !== input.sellables.length ||
    facts.size !== required.size ||
    paths.size !== input.provenance.paths.length ||
    paths.size !== required.size ||
    input.provenance.brandReference !== menu.brandReference ||
    input.provenance.menuVersionReference !== menu.draft.versionReference ||
    input.provenance.defaultLocale !== menu.draft.defaultLocale
  )
    return fail();
  for (const reference of required) {
    const fact = facts.get(reference),
      path = paths.get(reference);
    if (
      !fact ||
      !path ||
      fact.brandReference !== menu.brandReference ||
      fact.productVersionReference !== path.productVersionReference
    )
      return fail();
    const enabled = new Set(fact.optionRules.flatMap((rule) => rule.enabledOptionReferences));
    const covered = Object.keys(path.optionEvidenceReferences);
    if (
      enabled.size !== covered.length ||
      covered.some((option) => !enabled.has(option as CatalogReference))
    )
      return fail();
  }
  // Temporary validation binding is derived from the actual inputs. Only the
  // disclosures are used; final Publishing evidence must bind the stored digest.
  const snapshotDigest = parsePublishingDigest(
    "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({
          menu,
          sellables: input.sellables,
          provenance: input.provenance,
        }),
      ),
  );
  const { disclosures } = validateMenuAllergenProvenance({
    snapshot: { ...input.provenance, snapshotDigest },
    checkedAt: input.checkedAt,
    evidenceReference: input.validationEvidenceReference,
  });
  return parseReviewedMenuContent({
    brandReference: menu.brandReference,
    menuReference: menu.menuReference,
    menuVersionReference: menu.draft.versionReference,
    defaultLocale: menu.draft.defaultLocale,
    localizedNames: menu.draft.localizedNames,
    storeReferences: menu.draft.storeReferences,
    channelCodes: menu.draft.channelCodes,
    orderTypeCodes: menu.draft.orderTypeCodes,
    sections: menu.draft.sections.map((section) => ({
      sectionReference: section.sectionReference,
      internalCode: section.internalCode,
      localizedNames: section.localizedNames,
      sortOrder: section.sortOrder,
      sellables: section.placements.map((placement) => {
        const fact = facts.get(placement.sellableReference);
        const allergenDisclosure = disclosures[placement.sellableReference];
        if (!fact || !allergenDisclosure) return fail();
        const productLifecycle = parseProductLifecycle(fact.productLifecycle);
        const skuLifecycle = parseProductLifecycle(fact.skuLifecycle);
        return {
          placementReference: placement.placementReference,
          sellableReference: placement.sellableReference,
          productVersionReference: fact.productVersionReference,
          localizedNames: parseLocalizedNames(
            {
              ...fact.localizedNames,
              ...placement.localizedNameOverrides,
            },
            menu.draft.defaultLocale,
          ),
          presentationRole: placement.presentationRole,
          sortOrder: placement.sortOrder,
          pinned: placement.pinned,
          configuredAvailability:
            productLifecycle === "Active" && skuLifecycle === "Active"
              ? "Available"
              : "Unavailable",
          optionRules: fact.optionRules,
          allergenDisclosure,
        };
      }),
    })),
  });
}
