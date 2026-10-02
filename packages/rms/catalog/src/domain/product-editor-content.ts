import {
  CatalogError,
  parseCatalogCode,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
  parseVariantSelections,
  type ProductVersion,
  type VariantSelection,
} from "./product.js";

export interface ProductContentReference {
  readonly reference: string;
  readonly versionReference: string;
}
export type ProductAttributeValue =
  | { readonly attributeReference: string; readonly type: "Text"; readonly value: string }
  | { readonly attributeReference: string; readonly type: "Boolean"; readonly value: boolean }
  | {
      readonly attributeReference: string;
      readonly type: "Decimal";
      readonly value: string;
      readonly unitCode: string | null;
    }
  | { readonly attributeReference: string; readonly type: "Enum"; readonly valueReference: string };
export interface ProductContentMedia {
  readonly mediaReference: string;
  readonly assetReference: string;
  readonly assetVersionReference: string;
  readonly role: "Primary" | "Gallery" | "ThumbnailCandidate" | "Instructional";
  readonly altText: Readonly<Record<string, string>>;
  readonly sortOrder: number;
  readonly cropReference: string | null;
  readonly focusReference: string | null;
}
export interface ProductVariantDimension {
  readonly dimensionReference: string;
  readonly code: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly sortOrder: number;
  readonly selectionRequirement: "Required" | "Optional";
  readonly values: readonly {
    readonly valueReference: string;
    readonly code: string;
    readonly localizedNames: Readonly<Record<string, string>>;
    readonly sortOrder: number;
    readonly attributeReference: string | null;
    readonly mediaReference: string | null;
  }[];
}
export interface ProductVariantCombination {
  readonly selections: readonly VariantSelection[];
  readonly disposition: "Valid" | "Invalid" | "NotGenerated";
  readonly skuReference: string | null;
}
export interface ProductOptionContentRule {
  readonly bindingReference: string;
  readonly versionResolution: "Pinned" | "CurrentPublished";
  readonly pricingRule: ProductContentReference | null;
  readonly conditionalRule: ProductContentReference | null;
  readonly conflictRule: ProductContentReference | null;
  readonly variantCondition: readonly VariantSelection[];
}
/** Complete Catalog-owned content candidate. Owner reference/registry checks,
 * current policy, approval and publication authority are additional requirements. */
export interface ProductEditorContent {
  readonly profile: "CatalogProductEditorContentV1";
  readonly sourceDraft: ProductVersion;
  readonly localizedShortDescriptions: Readonly<Record<string, string>>;
  readonly localizedDescriptions: Readonly<Record<string, string>>;
  readonly preparationNotes: Readonly<Record<string, string>>;
  readonly tagReferences: readonly string[];
  readonly attributeValues: readonly ProductAttributeValue[];
  readonly media: readonly ProductContentMedia[];
  readonly variantDimensions: readonly ProductVariantDimension[];
  readonly variantCombinations: readonly ProductVariantCombination[];
  readonly optionRules: readonly ProductOptionContentRule[];
  readonly allergenReferences: readonly string[];
  readonly nutritionProfile: ProductContentReference | null;
}
export type ProductEditorContentDetails = Omit<ProductEditorContent, "sourceDraft">;

/** Persistable additional value; the supported Draft is stored by its existing owner. */
export function parseProductEditorContentDetails(
  value: unknown,
  draft: Pick<ProductVersion, "defaultLocale" | "skus" | "optionBindings">,
): ProductEditorContentDetails {
  let budget = 100000;
  const copy = (input: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return invalid();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return input.length <= 4096 ? input : invalid();
    if (typeof input === "number") return Number.isFinite(input) ? input : invalid();
    if (!input || typeof input !== "object") return invalid();
    const keys = Reflect.ownKeys(input);
    if (Array.isArray(input)) {
      if (
        Object.getPrototypeOf(input) !== Array.prototype ||
        input.length > 10000 ||
        keys.length !== input.length + 1
      )
        return invalid();
      return Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
        return copy(descriptor.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(input) !== Object.prototype || keys.length > 128) return invalid();
    return Object.fromEntries(
      keys.map((key) => {
        if (typeof key !== "string") return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
        return [key, copy(descriptor.value, depth + 1)];
      }),
    );
  };
  const parsed = parseProductEditorContentStructure(copy(value, 0), draft);
  const { sourceDraft, ...details } = parsed;
  void sourceDraft;
  return Object.freeze(details);
}

const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
// Public boundary copies bounded descriptors before this owning structural parser.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function list<T>(value: unknown, parse: (v: unknown) => T, maximum = 1000): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return Object.freeze(value.map(parse));
}
function unique<T>(values: readonly T[], key: (v: T) => unknown) {
  if (new Set(values.map(key)).size !== values.length) return invalid();
  return values;
}
function references(value: unknown): readonly string[] {
  return Object.freeze([...unique(list(value, parseCatalogReference), (v) => v)].sort());
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2147483647)
    return invalid();
  return value as number;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid();
  return value as T;
}
const nullableReference = (value: unknown) =>
  value === null ? null : parseCatalogReference(value);
function reference(value: unknown): ProductContentReference | null {
  if (value === null) return null;
  const r = record(value, ["reference", "versionReference"]);
  return Object.freeze({
    reference: parseCatalogReference(r.reference),
    versionReference: parseCatalogReference(r.versionReference),
  });
}
function text(value: unknown, maximum: number, lines = false): string {
  if (typeof value !== "string") return invalid();
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  // No markup, URLs, terminal control characters or zero-width bidi controls.
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    /[<>{}]|\[|\]|https?:\/\/|www\.|(?:^|\s)[#*_`]|(?:^|\n)\s*(?:[-+]\s|\d+[.)]\s)|[\u202a-\u202e\u2066-\u2069]/iu.test(
      normalized,
    ) ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    }) ||
    (!lines && /\n/u.test(normalized))
  )
    return invalid();
  return lines
    ? normalized
        .split("\n")
        .map((line) => line.replace(/[\t ]+/gu, " ").trim())
        .join("\n")
    : normalized.replace(/\s+/gu, " ");
}
function localized(
  value: unknown,
  maximum: number,
  lines = false,
): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32)
    return invalid();
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [parseCatalogLocale(key), text(item, maximum, lines)]),
    ),
  );
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/u.test(value))
    return invalid();
  const [whole, fraction] = value.split("."),
    tail = fraction?.replace(/0+$/u, "");
  const result = String(BigInt(whole ?? "0")) + (tail ? "." + tail : "");
  // Preserve the sign for values between -1 and 0, without floating point.
  return value.startsWith("-") && result.startsWith("0.") ? "-" + result : result;
}
function attribute(value: unknown): ProductAttributeValue {
  const type = (value as Record<string, unknown>)?.type;
  const r = record(
    value,
    type === "Decimal"
      ? ["attributeReference", "type", "value", "unitCode"]
      : type === "Enum"
        ? ["attributeReference", "type", "valueReference"]
        : ["attributeReference", "type", "value"],
  );
  const attributeReference = parseCatalogReference(r.attributeReference);
  if (type === "Text")
    return Object.freeze({ attributeReference, type, value: text(r.value, 240) });
  if (type === "Boolean") {
    if (typeof r.value !== "boolean") return invalid();
    return Object.freeze({ attributeReference, type, value: r.value });
  }
  if (type === "Decimal")
    return Object.freeze({
      attributeReference,
      type,
      value: decimal(r.value),
      unitCode: r.unitCode === null ? null : parseCatalogCode(r.unitCode),
    });
  if (type === "Enum")
    return Object.freeze({
      attributeReference,
      type,
      valueReference: parseCatalogReference(r.valueReference),
    });
  return invalid();
}
const selectionKey = (selections: readonly VariantSelection[]) =>
  [...selections]
    .sort((a, b) => a.dimensionReference.localeCompare(b.dimensionReference))
    .map((s) => s.dimensionReference + ":" + s.valueReference)
    .join("|");
/** Receives only a parsed supported Draft and copied content from the public boundary. */
export function parseProductEditorContentStructure<
  Draft extends Pick<ProductVersion, "defaultLocale" | "skus" | "optionBindings">,
>(value: unknown, draft: Draft): ProductEditorContentDetails & { readonly sourceDraft: Draft } {
  const r = record(value, [
    "profile",
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
  ]);
  if (r.profile !== "CatalogProductEditorContentV1") return invalid();
  const media = list(
    r.media,
    (v): ProductContentMedia => {
      const m = record(v, [
        "mediaReference",
        "assetReference",
        "assetVersionReference",
        "role",
        "altText",
        "sortOrder",
        "cropReference",
        "focusReference",
      ]);
      return Object.freeze({
        mediaReference: parseCatalogReference(m.mediaReference),
        assetReference: parseCatalogReference(m.assetReference),
        assetVersionReference: parseCatalogReference(m.assetVersionReference),
        role: enumeration(m.role, [
          "Primary",
          "Gallery",
          "ThumbnailCandidate",
          "Instructional",
        ] as const),
        altText: localized(m.altText, 240),
        sortOrder: number(m.sortOrder),
        cropReference: nullableReference(m.cropReference),
        focusReference: nullableReference(m.focusReference),
      });
    },
    100,
  );
  unique(media, (m) => m.mediaReference);
  unique(media, (m) => m.sortOrder);
  if (media.filter((m) => m.role === "Primary").length > 1) return invalid();
  const attributeValues = unique(list(r.attributeValues, attribute), (a) => a.attributeReference);
  const dimensions = list(
    r.variantDimensions,
    (v): ProductVariantDimension => {
      const d = record(v, [
        "dimensionReference",
        "code",
        "localizedNames",
        "sortOrder",
        "selectionRequirement",
        "values",
      ]);
      const values = list(
        d.values,
        (v): ProductVariantDimension["values"][number] => {
          const a = record(v, [
            "valueReference",
            "code",
            "localizedNames",
            "sortOrder",
            "attributeReference",
            "mediaReference",
          ]);
          const attributeReference = nullableReference(a.attributeReference),
            mediaReference = nullableReference(a.mediaReference);
          if (mediaReference !== null && !media.some((m) => m.mediaReference === mediaReference))
            return invalid();
          if (
            attributeReference !== null &&
            !attributeValues.some((a) => a.attributeReference === attributeReference)
          )
            return invalid();
          return Object.freeze({
            valueReference: parseCatalogReference(a.valueReference),
            code: parseCatalogCode(a.code),
            localizedNames: parseLocalizedNames(a.localizedNames, draft.defaultLocale),
            sortOrder: number(a.sortOrder),
            attributeReference,
            mediaReference,
          });
        },
        100,
      );
      unique(values, (a) => a.valueReference);
      unique(values, (a) => a.code);
      unique(values, (a) => a.sortOrder);
      return Object.freeze({
        dimensionReference: parseCatalogReference(d.dimensionReference),
        code: parseCatalogCode(d.code),
        localizedNames: parseLocalizedNames(d.localizedNames, draft.defaultLocale),
        sortOrder: number(d.sortOrder),
        selectionRequirement: enumeration(d.selectionRequirement, [
          "Required",
          "Optional",
        ] as const),
        values: Object.freeze([...values].sort((a, b) => a.sortOrder - b.sortOrder)),
      });
    },
    32,
  );
  unique(dimensions, (d) => d.dimensionReference);
  unique(dimensions, (d) => d.code);
  unique(dimensions, (d) => d.sortOrder);
  unique(
    dimensions.flatMap((d) => d.values),
    (v) => v.valueReference,
  );
  function selections(value: unknown) {
    const parsed = parseVariantSelections(value);
    for (const s of parsed)
      if (
        !dimensions.some(
          (d) =>
            d.dimensionReference === s.dimensionReference &&
            d.values.some((v) => v.valueReference === s.valueReference),
        )
      )
        return invalid();
    return Object.freeze(
      [...parsed].sort((a, b) => a.dimensionReference.localeCompare(b.dimensionReference)),
    );
  }
  const combinations = list(r.variantCombinations, (v): ProductVariantCombination => {
    const c = record(v, ["selections", "disposition", "skuReference"]),
      selection = selections(c.selections),
      disposition = enumeration(c.disposition, ["Valid", "Invalid", "NotGenerated"] as const),
      skuReference = nullableReference(c.skuReference);
    if ((disposition === "Valid") !== (skuReference !== null)) return invalid();
    if (skuReference !== null) {
      const sku = draft.skus.find((s) => s.skuReference === skuReference);
      if (
        !sku ||
        selectionKey(sku.variantSelections) !== selectionKey(selection) ||
        dimensions.some(
          (d) =>
            d.selectionRequirement === "Required" &&
            !selection.some((s) => s.dimensionReference === d.dimensionReference),
        )
      )
        return invalid();
    }
    return Object.freeze({ selections: selection, disposition, skuReference });
  });
  unique(combinations, (c) => selectionKey(c.selections));
  unique(
    combinations.filter((c) => c.skuReference !== null),
    (c) => c.skuReference,
  );
  for (const sku of draft.skus) {
    selections(sku.variantSelections);
    if (
      (sku.variantSelections.length > 0 || dimensions.length > 0) &&
      !combinations.some((c) => c.skuReference === sku.skuReference && c.disposition === "Valid")
    )
      return invalid();
  }
  const optionRules = list(r.optionRules, (v): ProductOptionContentRule => {
    const o = record(v, [
      "bindingReference",
      "versionResolution",
      "pricingRule",
      "conditionalRule",
      "conflictRule",
      "variantCondition",
    ]);
    const bindingReference = parseCatalogReference(o.bindingReference);
    if (!draft.optionBindings.some((b) => b.bindingReference === bindingReference))
      return invalid();
    return Object.freeze({
      bindingReference,
      versionResolution: enumeration(o.versionResolution, ["Pinned", "CurrentPublished"] as const),
      pricingRule: reference(o.pricingRule),
      conditionalRule: reference(o.conditionalRule),
      conflictRule: reference(o.conflictRule),
      variantCondition: selections(o.variantCondition),
    });
  });
  unique(optionRules, (o) => o.bindingReference);
  if (optionRules.length !== draft.optionBindings.length) return invalid();
  return Object.freeze({
    profile: "CatalogProductEditorContentV1",
    sourceDraft: draft,
    localizedShortDescriptions: localized(r.localizedShortDescriptions, 240),
    localizedDescriptions: localized(r.localizedDescriptions, 4096, true),
    preparationNotes: localized(r.preparationNotes, 1000, true),
    tagReferences: references(r.tagReferences),
    attributeValues: Object.freeze(
      [...attributeValues].sort((a, b) => a.attributeReference.localeCompare(b.attributeReference)),
    ),
    media: Object.freeze([...media].sort((a, b) => a.sortOrder - b.sortOrder)),
    variantDimensions: Object.freeze([...dimensions].sort((a, b) => a.sortOrder - b.sortOrder)),
    variantCombinations: Object.freeze(
      [...combinations].sort((a, b) =>
        selectionKey(a.selections).localeCompare(selectionKey(b.selections)),
      ),
    ),
    optionRules: Object.freeze(
      [...optionRules].sort((a, b) => a.bindingReference.localeCompare(b.bindingReference)),
    ),
    allergenReferences: references(r.allergenReferences),
    nutritionProfile: reference(r.nutritionProfile),
  });
}
