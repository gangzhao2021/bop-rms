import { CatalogError, type ProductAggregate } from "../contracts/product.js";
/** Structural outer-unit-of-work interface; this collaborator performs no SQL. */
export interface ProductEditorContentTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount?: number | null }>;
}
export const productEditorContentFields = Object.freeze([
  "editorContent",
  "localizedShortDescriptions",
  "localizedDescriptions",
  "preparationNotes",
  "tagReferences",
  "attributeValues",
  "media",
  "variantDimensions",
  "variantCombinations",
  "optionRules",
  "allergenReferences",
  "nutritionProfile",
] as const);
export const productEditorContentReferenceChecks = Object.freeze([
  "BrandContentPolicy",
  "TagRegistry",
  "AttributeRegistry",
  "Media",
  "OptionSet",
  "VariantIdentityHistory",
  "SafetyVocabulary",
  "Nutrition",
] as const);
export interface ProductEditorContentAuthority {
  /** Current caller purpose/scope/fields, plus owning current reference/registry
   * checks for writes/publication, held through outer transaction completion.
   * The adapter must resolve Actor/clock/current policy itself; no DTO authority. */
  holdUntilTransactionCompletes(
    tx: ProductEditorContentTransaction,
    input: {
      readonly mode: "Read" | "DraftWrite" | "Publish";
      readonly aggregate: ProductAggregate;
      readonly requiredFields: typeof productEditorContentFields;
      readonly requiredReferenceChecks: readonly (typeof productEditorContentReferenceChecks)[number][];
    },
  ): Promise<void>;
}
export async function holdProductEditorContent(
  tx: ProductEditorContentTransaction,
  authority: ProductEditorContentAuthority | undefined,
  aggregate: ProductAggregate,
  mode: "Read" | "DraftWrite" | "Publish",
): Promise<void> {
  if (aggregate.draft.editorContent === undefined) return;
  if (typeof authority?.holdUntilTransactionCompletes !== "function")
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  await authority.holdUntilTransactionCompletes(
    tx,
    Object.freeze({
      mode,
      aggregate,
      requiredFields: productEditorContentFields,
      requiredReferenceChecks:
        mode === "Read" ? Object.freeze([]) : productEditorContentReferenceChecks,
    }),
  );
}
