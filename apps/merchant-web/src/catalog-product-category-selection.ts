import {
  parseProductCategoryClassification,
  type ProductCategoryClassification,
  type ProductVersion,
} from "./catalog-product-command-values.js";
import {
  parseProductCategoryLookupView,
  type ProductCategoryLookupScreen,
  type ProductCategoryLookupScope,
  type CatalogProductCategoryLookup,
} from "./catalog-product-category-lookup-client.js";
import type {
  ProductDraftEditingSession,
  ProductDraftBaselineExpectedScope,
} from "./catalog-product-draft-baseline.js";
export class ProductCategorySelectionError extends Error {
  constructor(readonly code: "Invalid" | "Unavailable" | "Stale") {
    super("Product categories could not be selected");
    this.name = "ProductCategorySelectionError";
  }
}
function lookup(
  value: unknown,
  parent: ProductCategoryLookupScreen,
  scope: ProductCategoryLookupScope,
  observedAt: number,
): CatalogProductCategoryLookup {
  try {
    const result = parseProductCategoryLookupView(value, parent, scope).lookup;
    const sourceAt = Date.parse(result.projection.asOfUtc);
    if (!Number.isFinite(observedAt) || sourceAt > observedAt)
      throw new ProductCategorySelectionError("Unavailable");
    if (observedAt - sourceAt > 5000) throw new ProductCategorySelectionError("Stale");
    return result;
  } catch (error) {
    if (error instanceof ProductCategorySelectionError) throw error;
    throw new ProductCategorySelectionError("Unavailable");
  }
}
/** Current choices are a UI constraint; owning mutation still verifies current authority/policy. */
export function selectProductCategoryClassification(
  value: unknown,
  lookupValue: unknown,
  parent: ProductCategoryLookupScreen,
  scope: ProductCategoryLookupScope,
  observedAt: number,
): ProductCategoryClassification {
  const current = lookup(lookupValue, parent, scope, observedAt);
  let selected: ProductCategoryClassification;
  try {
    selected = parseProductCategoryClassification(value);
  } catch {
    throw new ProductCategorySelectionError("Invalid");
  }
  const eligible = new Set(current.items.map((item) => item.categoryReference));
  if (selected.categoryReferences.some((ref) => !eligible.has(ref)))
    throw new ProductCategorySelectionError("Invalid");
  return selected;
}
export type ProductCategorySelectionView =
  | { readonly coverage: "Unavailable"; readonly selected: null }
  | {
      readonly coverage: "Known";
      readonly primaryCategoryReference: string | null;
      readonly selected: readonly {
        readonly categoryReference: string;
        readonly primary: boolean;
        readonly eligibility: "Eligible" | "NotInEligibleChoices";
        readonly name: string | null;
        readonly lifecycle: "Draft" | "Active" | null;
      }[];
    };
export interface ProductCategoryEditingContext {
  readonly scope: ProductDraftBaselineExpectedScope;
  readonly locale: string;
  readonly observedAt: number;
}
function editLookup(
  session: ProductDraftEditingSession,
  draftValue: unknown,
  lookupValue: unknown,
  context: ProductCategoryEditingContext,
) {
  const draft = session.parseDraft(draftValue, context.scope);
  const current = lookup(
    lookupValue,
    "CAT-PRODUCT-EDIT",
    {
      brandReference: context.scope.brandReference,
      storeReference: context.scope.storeReference,
      locale: context.locale,
    },
    context.observedAt,
  );
  return { draft, current };
}
/** Preserve stored members; omission from eligible choices reveals no historical lifecycle or cause. */
export function deriveProductCategorySelectionView(
  session: ProductDraftEditingSession,
  draftValue: unknown,
  lookupValue: unknown,
  context: ProductCategoryEditingContext,
): ProductCategorySelectionView {
  const { draft, current } = editLookup(session, draftValue, lookupValue, context),
    classification = draft.categoryClassification;
  if (classification === undefined)
    return Object.freeze({ coverage: "Unavailable", selected: null });
  const choices = new Map(current.items.map((item) => [item.categoryReference, item]));
  return Object.freeze({
    coverage: "Known",
    primaryCategoryReference: classification.primaryCategoryReference,
    selected: Object.freeze(
      classification.categoryReferences.map((categoryReference) => {
        const item = choices.get(categoryReference);
        return Object.freeze({
          categoryReference,
          primary: categoryReference === classification.primaryCategoryReference,
          eligibility: item ? "Eligible" : "NotInEligibleChoices",
          name: item?.name ?? null,
          lifecycle: item?.lifecycle ?? null,
        });
      }),
    ),
  });
}
/** Explicit replacement only. No automatic removal, default classification or primary. */
export function replaceProductDraftCategorySelection(
  session: ProductDraftEditingSession,
  draftValue: unknown,
  value: unknown,
  lookupValue: unknown,
  context: ProductCategoryEditingContext,
): ProductVersion {
  const { draft } = editLookup(session, draftValue, lookupValue, context);
  const selected = selectProductCategoryClassification(
    value,
    lookupValue,
    "CAT-PRODUCT-EDIT",
    {
      brandReference: context.scope.brandReference,
      storeReference: context.scope.storeReference,
      locale: context.locale,
    },
    context.observedAt,
  );
  return session.parseDraft({ ...draft, categoryClassification: selected }, context.scope);
}
