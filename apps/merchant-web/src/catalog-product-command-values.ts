/** Closed normal Product wire values. Independent of owning Domain runtime.
 * Complete optional Draft content is a wire candidate, never source authority. */
import {
  parseProductEditorContentDetails,
  type ProductEditorContentDetails,
} from "./product-editor-content-values.js";
export class ProductCommandClientError extends Error {
  constructor(
    readonly code:
      "Invalid" | "Denied" | "FeatureDisabled" | "Conflict" | "Unavailable" | "OutcomeUnknown",
    readonly attemptCode?: "Invalid" | "Denied" | "FeatureDisabled" | "Conflict",
  ) {
    super("Product save could not be confirmed");
    this.name = "ProductCommandClientError";
  }
}
type CatalogReference = string;
type CatalogInstant = string;
type CatalogCode = string;
type CatalogDecimal = string;
export type ProductLifecycle = "Draft" | "Active" | "Suspended" | "Discontinued" | "Archived";
type SkuLifecycle = ProductLifecycle;
export type ProductType = "PreparedFood" | "NonAlcoholicBeverage";
export interface VariantSelection {
  readonly dimensionReference: CatalogReference;
  readonly valueReference: CatalogReference;
}
export interface CatalogSku {
  readonly skuReference: CatalogReference;
  readonly productReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly skuCode: CatalogCode;
  readonly lifecycle: SkuLifecycle;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly variantSelections: readonly VariantSelection[];
  readonly unitOfSale: CatalogCode;
  readonly unitQuantity: CatalogDecimal;
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
}
/** Product Version organization value. Omitted legacy data is not an empty set. */
export interface ProductCategoryClassification {
  readonly categoryReferences: readonly CatalogReference[];
  readonly primaryCategoryReference: CatalogReference | null;
}

export interface ProductVersion {
  readonly editorContent?: ProductEditorContentDetails;
  readonly categoryClassification?: ProductCategoryClassification;
  readonly versionReference: CatalogReference;
  readonly baseVersionReference: CatalogReference | null;
  readonly status: "Draft";
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly taxClassificationReference: CatalogReference | null;
  readonly skus: readonly CatalogSku[];
  readonly optionBindings: readonly ProductOptionBinding[];
  readonly createdAt: CatalogInstant;
  readonly updatedAt: CatalogInstant;
}

export interface OptionSelectionQuantity {
  readonly optionReference: CatalogReference;
  readonly quantity: number;
}

export interface ProductOptionBinding {
  readonly bindingReference: CatalogReference;
  readonly optionSetReference: CatalogReference;
  readonly optionSetVersionReference: CatalogReference;
  readonly purpose: CatalogCode;
  readonly sortOrder: number;
  readonly enabledOptionReferences: readonly CatalogReference[];
  readonly defaultSelections: readonly OptionSelectionQuantity[];
  readonly minimumSelectionOverride: number | null;
  readonly maximumSelectionOverride: number | null;
  readonly includedSkuReferences: readonly CatalogReference[];
  readonly excludedSkuReferences: readonly CatalogReference[];
  readonly channelCodes: readonly CatalogCode[];
  readonly storeOverrideAllowed: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const decimal = /^(?:0*[1-9]\d*)(?:\.\d{1,6})?$|^0\.(?:0{0,5}[1-9]\d{0,5})$/u;
const locale = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;

function invalid(): never {
  throw new ProductCommandClientError("Invalid");
}
function exact(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const own = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      own.length < keys.length ||
      own.length > keys.length + optional.length ||
      own.some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of [...keys, ...optional.filter((key) => Object.hasOwn(value, key))]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof ProductCommandClientError) throw error;
    return invalid();
  }
}
function items(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > 10000
  )
    return invalid();
  const n: number = length.value;
  if (Reflect.ownKeys(value).length !== n + 1) return invalid();
  const result: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d) || !d.enumerable) return invalid();
    result.push(d.value);
  }
  return result;
}
export function parseProductCategoryClassification(value: unknown): ProductCategoryClassification {
  try {
    const raw = exact(value, ["categoryReferences", "primaryCategoryReference"]);
    const refs = items(raw.categoryReferences).map(parseCatalogReference);
    if (new Set(refs).size !== refs.length) return invalid();
    const primary =
      raw.primaryCategoryReference === null
        ? null
        : parseCatalogReference(raw.primaryCategoryReference);
    if (primary !== null && !refs.includes(primary)) return invalid();
    return Object.freeze({
      categoryReferences: Object.freeze(refs.sort()),
      primaryCategoryReference: primary,
    });
  } catch {
    return invalid();
  }
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}
function optionalNonnegative(value: unknown): number | null {
  return value === null ? null : nonnegative(value);
}
function uniqueReferences(value: unknown): readonly CatalogReference[] {
  if (!Array.isArray(value)) return invalid();
  const parsed = Object.freeze(value.map(parseCatalogReference));
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}
export function parseCatalogReference(value: unknown): CatalogReference {
  if (typeof value !== "string" || !uuid.test(value)) return invalid();
  return value as CatalogReference;
}
export function parseCatalogInstant(value: unknown): CatalogInstant {
  if (typeof value !== "string" || !instant.test(value)) return invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return invalid();
  return value as CatalogInstant;
}
export function parseCatalogCode(value: unknown): CatalogCode {
  if (typeof value !== "string") return invalid();
  const normalized = value.trim().toUpperCase();
  if (!code.test(normalized)) return invalid();
  return normalized as CatalogCode;
}
export function parseCatalogDecimal(value: unknown): CatalogDecimal {
  if (typeof value !== "string" || !decimal.test(value)) return invalid();
  const [whole, fraction] = value.split(".");
  const normalizedWhole = String(BigInt(whole ?? "0"));
  const normalizedFraction = fraction?.replace(/0+$/u, "") ?? "";
  return `${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ""}` as CatalogDecimal;
}
export function parseCatalogLocale(value: unknown): string {
  if (typeof value !== "string" || !locale.test(value)) return invalid();
  return value;
}
export function parseLocalizedNames(
  value: unknown,
  defaultLocale: unknown,
): Readonly<Record<string, string>> {
  const parsedDefaultLocale = parseCatalogLocale(defaultLocale);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const entries = Object.entries(value);
  if (!entries.length || !Object.hasOwn(value, parsedDefaultLocale)) return invalid();
  const normalized: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (
      !locale.test(key) ||
      typeof raw !== "string" ||
      raw.trim().length < 1 ||
      raw.trim().length > 120 ||
      /[<>{}]|\[|\]|https?:\/\/|www\.|(?:^|\s)[#*_`]/iu.test(raw)
    )
      return invalid();
    normalized[key] = raw.trim().replace(/\s+/gu, " ");
  }
  return Object.freeze(normalized);
}
function lifecycle(value: unknown): ProductLifecycle {
  if (
    value !== "Draft" &&
    value !== "Active" &&
    value !== "Suspended" &&
    value !== "Discontinued" &&
    value !== "Archived"
  )
    return invalid();
  return value;
}
export function parseProductLifecycle(value: unknown): ProductLifecycle {
  return lifecycle(value);
}
export function parseVariantSelection(value: unknown): VariantSelection {
  const raw = exact(value, ["dimensionReference", "valueReference"]);
  return Object.freeze({
    dimensionReference: parseCatalogReference(raw.dimensionReference),
    valueReference: parseCatalogReference(raw.valueReference),
  });
}
export function parseVariantSelections(value: unknown): readonly VariantSelection[] {
  if (!Array.isArray(value)) return invalid();
  const selections = Object.freeze(value.map(parseVariantSelection));
  if (new Set(selections.map((item) => item.dimensionReference)).size !== selections.length)
    return invalid();
  return selections;
}
export function parseProductOptionBinding(value: unknown): ProductOptionBinding {
  const raw = exact(value, [
    "bindingReference",
    "optionSetReference",
    "optionSetVersionReference",
    "purpose",
    "sortOrder",
    "enabledOptionReferences",
    "defaultSelections",
    "minimumSelectionOverride",
    "maximumSelectionOverride",
    "includedSkuReferences",
    "excludedSkuReferences",
    "channelCodes",
    "storeOverrideAllowed",
  ]);
  if (!Array.isArray(raw.defaultSelections) || !Array.isArray(raw.channelCodes)) return invalid();
  const enabledOptionReferences = uniqueReferences(raw.enabledOptionReferences);
  const includedSkuReferences = uniqueReferences(raw.includedSkuReferences);
  const excludedSkuReferences = uniqueReferences(raw.excludedSkuReferences);
  if (includedSkuReferences.some((reference) => excludedSkuReferences.includes(reference)))
    return invalid();
  const defaultSelections = Object.freeze(
    raw.defaultSelections.map((candidate) => {
      const selection = exact(candidate, ["optionReference", "quantity"]);
      return Object.freeze({
        optionReference: parseCatalogReference(selection.optionReference),
        quantity: positive(selection.quantity),
      });
    }),
  );
  if (
    new Set(defaultSelections.map((selection) => selection.optionReference)).size !==
      defaultSelections.length ||
    defaultSelections.some(
      (selection) => !enabledOptionReferences.includes(selection.optionReference),
    )
  )
    return invalid();
  const minimumSelectionOverride = optionalNonnegative(raw.minimumSelectionOverride);
  const maximumSelectionOverride = optionalNonnegative(raw.maximumSelectionOverride);
  if (
    maximumSelectionOverride !== null &&
    minimumSelectionOverride !== null &&
    maximumSelectionOverride < minimumSelectionOverride
  )
    return invalid();
  const channelCodes = Object.freeze(raw.channelCodes.map(parseCatalogCode));
  if (
    new Set(channelCodes).size !== channelCodes.length ||
    typeof raw.storeOverrideAllowed !== "boolean"
  )
    return invalid();
  return Object.freeze({
    bindingReference: parseCatalogReference(raw.bindingReference),
    optionSetReference: parseCatalogReference(raw.optionSetReference),
    optionSetVersionReference: parseCatalogReference(raw.optionSetVersionReference),
    purpose: parseCatalogCode(raw.purpose),
    sortOrder: nonnegative(raw.sortOrder),
    enabledOptionReferences,
    defaultSelections,
    minimumSelectionOverride,
    maximumSelectionOverride,
    includedSkuReferences,
    excludedSkuReferences,
    channelCodes,
    storeOverrideAllowed: raw.storeOverrideAllowed,
  });
}
export function parseCatalogSku(value: unknown): CatalogSku {
  const raw = exact(value, [
    "skuReference",
    "productReference",
    "brandReference",
    "skuCode",
    "lifecycle",
    "localizedNames",
    "variantSelections",
    "unitOfSale",
    "unitQuantity",
    "createdAt",
    "createdByActorReference",
  ]);
  const selections = parseVariantSelections(raw.variantSelections);
  const localeKey = Object.keys(raw.localizedNames as object)[0];
  if (localeKey === undefined) return invalid();
  return Object.freeze({
    skuReference: parseCatalogReference(raw.skuReference),
    productReference: parseCatalogReference(raw.productReference),
    brandReference: parseCatalogReference(raw.brandReference),
    skuCode: parseCatalogCode(raw.skuCode),
    lifecycle: lifecycle(raw.lifecycle),
    localizedNames: parseLocalizedNames(raw.localizedNames, localeKey),
    variantSelections: selections,
    unitOfSale: parseCatalogCode(raw.unitOfSale),
    unitQuantity: parseCatalogDecimal(raw.unitQuantity),
    createdAt: parseCatalogInstant(raw.createdAt),
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
  });
}
export function parseProductVersion(value: unknown): ProductVersion {
  const raw = exact(
    value,
    [
      "versionReference",
      "baseVersionReference",
      "status",
      "defaultLocale",
      "localizedNames",
      "taxClassificationReference",
      "skus",
      "optionBindings",
      "createdAt",
      "updatedAt",
    ],
    ["categoryClassification", "editorContent"],
  );
  if (
    raw.status !== "Draft" ||
    typeof raw.defaultLocale !== "string" ||
    !locale.test(raw.defaultLocale)
  )
    return invalid();
  if (!Array.isArray(raw.skus) || !Array.isArray(raw.optionBindings)) return invalid();
  const skus = Object.freeze(raw.skus.map(parseCatalogSku));
  const optionBindings = Object.freeze(raw.optionBindings.map(parseProductOptionBinding));
  if (
    new Set(skus.map((sku) => sku.skuReference)).size !== skus.length ||
    new Set(skus.map((sku) => sku.skuCode)).size !== skus.length ||
    new Set(skus.map((sku) => JSON.stringify(sku.variantSelections))).size !== skus.length ||
    skus.some((sku) => !Object.hasOwn(sku.localizedNames, raw.defaultLocale as string)) ||
    new Set(optionBindings.map((binding) => binding.bindingReference)).size !==
      optionBindings.length ||
    new Set(optionBindings.map((binding) => binding.sortOrder)).size !== optionBindings.length ||
    new Set(optionBindings.map((binding) => `${binding.optionSetReference}:${binding.purpose}`))
      .size !== optionBindings.length ||
    optionBindings.some((binding) =>
      [...binding.includedSkuReferences, ...binding.excludedSkuReferences].some(
        (reference) => !skus.some((sku) => sku.skuReference === reference),
      ),
    )
  )
    return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  const draft: ProductVersion = Object.freeze({
    versionReference: parseCatalogReference(raw.versionReference),
    baseVersionReference:
      raw.baseVersionReference === null ? null : parseCatalogReference(raw.baseVersionReference),
    status: "Draft",
    defaultLocale: raw.defaultLocale,
    localizedNames: parseLocalizedNames(raw.localizedNames, raw.defaultLocale),
    taxClassificationReference:
      raw.taxClassificationReference === null
        ? null
        : parseCatalogReference(raw.taxClassificationReference),
    skus,
    optionBindings,
    ...(Object.hasOwn(raw, "categoryClassification")
      ? { categoryClassification: parseProductCategoryClassification(raw.categoryClassification) }
      : {}),
    createdAt,
    updatedAt,
  });
  return Object.hasOwn(raw, "editorContent")
    ? Object.freeze({
        ...draft,
        editorContent: parseProductEditorContentDetails(raw.editorContent, draft),
      })
    : draft;
}

/** Copy descriptors before inspecting nested values; getters and sparse arrays never execute. */
export function copyProductCommandValue(value: unknown): unknown {
  let budget = 10000;
  const seen = new WeakSet<object>();
  const copy = (input: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return invalid();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      if (input.length > 8192) return invalid();
      return input;
    }
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (!input || typeof input !== "object" || seen.has(input)) return invalid();
    seen.add(input);
    try {
      if (Array.isArray(input))
        return Object.freeze(items(input).map((item) => copy(item, depth + 1)));
      if (Object.getPrototypeOf(input) !== Object.prototype) return invalid();
      const pairs = Reflect.ownKeys(input).map((key) => {
        if (typeof key !== "string") return invalid();
        const d = Object.getOwnPropertyDescriptor(input, key);
        if (!d || !d.enumerable || !("value" in d)) return invalid();
        return [key, copy(d.value, depth + 1)] as const;
      });
      return Object.freeze(Object.fromEntries(pairs));
    } finally {
      seen.delete(input);
    }
  };
  try {
    return copy(value, 0);
  } catch {
    return invalid();
  }
}
export { exact as productCommandRecord };
