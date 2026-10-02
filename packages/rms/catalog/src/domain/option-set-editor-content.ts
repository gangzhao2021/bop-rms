import { CatalogError } from "./product.js";
import type { OptionSetAggregate } from "./option-set.js";
import type { ProductPublicationPeriod, ProductPublicationScope } from "./product-publication.js";

export interface OptionSetContentReference {
  readonly reference: string;
  readonly versionReference: string;
}
export interface OptionSetOptionDetails {
  readonly optionReference: string;
  readonly quantityRule: { readonly minimumQuantity: number; readonly maximumQuantity: number };
  readonly media: {
    readonly mediaReference: string;
    readonly assetReference: string;
    readonly assetVersionReference: string;
    readonly altText: Readonly<Record<string, string>>;
  } | null;
  readonly pricingRule: OptionSetContentReference | null;
  readonly consumption: {
    readonly kind: "Inventory" | "Recipe";
    readonly reference: string;
    readonly versionReference: string;
    readonly quantity: string;
    readonly unitCode: string;
  } | null;
  readonly triggeredOptionSetVersionReference: string | null;
}
export interface OptionSetConditionalRule {
  readonly ruleReference: string;
  readonly whenAllSelected: readonly string[];
  readonly requiredOptionReferences: readonly string[];
}
export interface OptionSetConflictRule {
  readonly ruleReference: string;
  readonly forbiddenTogether: readonly string[];
}
export interface OptionSetEditorContentDetails {
  readonly profile: "CatalogOptionSetEditorContentV1";
  readonly optionDetails: readonly OptionSetOptionDetails[];
  readonly conditionalRules: readonly OptionSetConditionalRule[];
  readonly conflictRules: readonly OptionSetConflictRule[];
  readonly scopeSet: readonly ProductPublicationScope[];
  readonly effectivePeriod: ProductPublicationPeriod;
}
export interface OptionSetEditorContent extends OptionSetEditorContentDetails {
  readonly sourceAggregate: OptionSetAggregate;
}

/** Local structural contradictions only. Held current graph/reference/policy
 * validation must still prove complete RuleSatisfiability before publication. */
export function validateOptionSetEditorRules(
  source: OptionSetAggregate,
  content: OptionSetEditorContentDetails,
): void {
  const fail = (): never => {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  };
  if (content.optionDetails.length !== source.draft.options.length) return fail();
  for (const detail of content.optionDetails) {
    const option = source.draft.options.find((o) => o.optionReference === detail.optionReference);
    if (
      !option ||
      detail.quantityRule.maximumQuantity > source.draft.perOptionMaximumQuantity ||
      (source.draft.maximumTotalQuantity !== null &&
        detail.quantityRule.maximumQuantity > source.draft.maximumTotalQuantity) ||
      (!source.draft.allowRepeatedOption && detail.quantityRule.maximumQuantity > 1) ||
      (option.triggeredOptionSetReference === null) !==
        (detail.triggeredOptionSetVersionReference === null)
    )
      return fail();
  }
  const known = new Set<string>(source.draft.options.map((o) => o.optionReference));
  const requireKnown = (references: readonly string[]) => {
    if (references.some((r) => !known.has(r))) return fail();
  };
  for (const rule of content.conflictRules) requireKnown(rule.forbiddenTogether);
  for (const rule of content.conditionalRules) {
    requireKnown(rule.whenAllSelected);
    requireKnown(rule.requiredOptionReferences);
    const required = new Set([...rule.whenAllSelected, ...rule.requiredOptionReferences]);
    if (
      content.conflictRules.some((conflict) =>
        conflict.forbiddenTogether.every((r) => required.has(r)),
      ) ||
      source.draft.options.some(
        (option) =>
          required.has(option.optionReference) &&
          option.conflictOptionReferences.some((r) => required.has(r)),
      )
    )
      return fail();
  }
}
