import { canonicalizeRfc8785 } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError } from "./product.js";
import { parseCatalogOptionSetEditorContent } from "./option-set-editor-content.js";

function readClosedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const copied = copyCategoryPersistenceValue(value);
  if (!copied || typeof copied !== "object" || Array.isArray(copied))
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const record = copied as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return record;
}

const draftFields = [
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
] as const;
const additionalFields = [
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
] as const;
function full(value: unknown) {
  const { sourceAggregate, ...additional } = readClosedRecord(copyCategoryPersistenceValue(value), [
    "profile",
    "sourceAggregate",
    ...additionalFields,
  ]);
  return parseCatalogOptionSetEditorContent(sourceAggregate, additional);
}
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);

/** Pure original-content comparison. Owning read authority and persistence
 * provenance must be acquired by the caller; parsing cannot grant either. */
export function compareCatalogOptionSetContent(value: unknown) {
  const input = readClosedRecord(copyCategoryPersistenceValue(value), ["left", "right"]);
  const left = full(input.left),
    right = full(input.right);
  const a = left.content.sourceAggregate,
    b = right.content.sourceAggregate;
  if (a.brandReference !== b.brandReference || a.optionSetReference !== b.optionSetReference)
    throw new CatalogError("CATALOG_INPUT_INVALID");
  if (
    a.internalCode !== b.internalCode ||
    a.createdAt !== b.createdAt ||
    a.createdByActorReference !== b.createdByActorReference
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const fields = [
    ...draftFields.map((field) => ({ field, left: a.draft[field], right: b.draft[field] })),
    ...additionalFields.map((field) => ({
      field,
      left: left.content[field],
      right: right.content[field],
    })),
  ]
    .filter((item) => !equal(item.left, item.right))
    .map((item) => Object.freeze(item));
  const oldOptions = new Map(
    a.draft.options.map((option) => [String(option.optionReference), option]),
  );
  const newOptions = new Map(
    b.draft.options.map((option) => [String(option.optionReference), option]),
  );
  const optionReferences = [...new Set([...oldOptions.keys(), ...newOptions.keys()])].sort();
  const options = optionReferences.flatMap((optionReference) => {
    const before = oldOptions.get(optionReference) ?? null;
    const after = newOptions.get(optionReference) ?? null;
    if (
      before &&
      after &&
      (before.stableCode !== after.stableCode ||
        before.createdAt !== after.createdAt ||
        before.createdByActorReference !== after.createdByActorReference)
    )
      throw new CatalogError("CATALOG_INPUT_INVALID");
    if (equal(before, after)) return [];
    return [
      Object.freeze({
        optionReference,
        change:
          before === null
            ? ("Added" as const)
            : after === null
              ? ("Removed" as const)
              : ("Changed" as const),
        left: before,
        right: after,
      }),
    ];
  });
  const identity = (source: typeof left) =>
    Object.freeze({
      versionReference: source.content.sourceAggregate.draft.versionReference,
      aggregateVersion: source.content.sourceAggregate.aggregateVersion,
      sourceDigest: source.sourceDigest,
      contentDigest: source.contentDigest,
      configurationDigest: source.configurationDigest,
    });
  return Object.freeze({
    profile: "CatalogOptionSetContentComparisonV1" as const,
    brandReference: a.brandReference,
    optionSetReference: a.optionSetReference,
    left: identity(left),
    right: identity(right),
    fields: Object.freeze(fields),
    options: Object.freeze(options),
    businessContentChanged: fields.length > 0 || options.length > 0,
    referenceEligibility: "NotEvaluated" as const,
    publicationStatus: "NotEvaluated" as const,
  });
}
