export const catalogErrorCodes = [
  "CATALOG_INPUT_INVALID",
  "CATALOG_UNAVAILABLE",
  "CATALOG_PERMISSION_DENIED",
  "CATALOG_VERSION_CONFLICT",
  "CATALOG_IDEMPOTENCY_CONFLICT",
  "CATALOG_CODE_CONFLICT",
  "CATALOG_LIFECYCLE_CONFLICT",
  "CATALOG_DEPENDENCY_UNAVAILABLE",
] as const;
export type CatalogErrorCode = (typeof catalogErrorCodes)[number];

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  constructor(code: CatalogErrorCode) {
    super(code === "CATALOG_INPUT_INVALID" ? "catalog input is invalid" : "catalog is unavailable");
    this.name = "CatalogError";
    this.code = code;
  }
}

export type CatalogReference = string & { readonly __catalogReference: unique symbol };
export type CatalogHash = string & { readonly __catalogHash: unique symbol };
export type CatalogInstant = string & { readonly __catalogInstant: unique symbol };
export type CatalogCode = string & { readonly __catalogCode: unique symbol };
export type CatalogDecimal = string & { readonly __catalogDecimal: unique symbol };
export type ProductLifecycle = "Draft" | "Active" | "Suspended" | "Discontinued" | "Archived";
export type SkuLifecycle = ProductLifecycle;
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
export interface ProductVersion {
  readonly versionReference: CatalogReference;
  readonly baseVersionReference: CatalogReference | null;
  readonly status: "Draft";
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly taxClassificationReference: CatalogReference | null;
  readonly skus: readonly CatalogSku[];
  readonly createdAt: CatalogInstant;
  readonly updatedAt: CatalogInstant;
}
export interface ProductAggregate {
  readonly productReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly productType: ProductType;
  readonly lifecycle: ProductLifecycle;
  readonly aggregateVersion: number;
  readonly draft: ProductVersion;
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
  readonly updatedAt: CatalogInstant;
}
export interface SkuSellable {
  readonly sellableReference: CatalogReference;
  readonly sellableType: "Sku";
  readonly productReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly lifecycle: SkuLifecycle;
  readonly catalogEligible: boolean;
  readonly unitOfSale: CatalogCode;
  readonly unitQuantity: CatalogDecimal;
  readonly taxClassificationReference: CatalogReference | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = /^[0-9a-f]{64}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const decimal = /^(?:0*[1-9]\d*)(?:\.\d{1,6})?$|^0\.(?:0{0,5}[1-9]\d{0,5})$/u;
const locale = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}
function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
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
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    return invalid();
  }
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
export function parseCatalogReference(value: unknown): CatalogReference {
  if (typeof value !== "string" || !uuid.test(value)) return invalid();
  return value as CatalogReference;
}
export function parseCatalogHash(value: unknown): CatalogHash {
  if (typeof value !== "string" || !hash.test(value)) return invalid();
  return value as CatalogHash;
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
  const raw = exact(value, [
    "versionReference",
    "baseVersionReference",
    "status",
    "defaultLocale",
    "localizedNames",
    "taxClassificationReference",
    "skus",
    "createdAt",
    "updatedAt",
  ]);
  if (
    raw.status !== "Draft" ||
    typeof raw.defaultLocale !== "string" ||
    !locale.test(raw.defaultLocale)
  )
    return invalid();
  if (!Array.isArray(raw.skus)) return invalid();
  const skus = Object.freeze(raw.skus.map(parseCatalogSku));
  if (
    new Set(skus.map((sku) => sku.skuReference)).size !== skus.length ||
    new Set(skus.map((sku) => sku.skuCode)).size !== skus.length ||
    new Set(skus.map((sku) => JSON.stringify(sku.variantSelections))).size !== skus.length ||
    skus.some((sku) => !Object.hasOwn(sku.localizedNames, raw.defaultLocale as string))
  )
    return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return Object.freeze({
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
    createdAt,
    updatedAt,
  });
}
export function parseProductAggregate(value: unknown): ProductAggregate {
  const raw = exact(value, [
    "productReference",
    "brandReference",
    "internalCode",
    "productType",
    "lifecycle",
    "aggregateVersion",
    "draft",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
  ]);
  if (raw.productType !== "PreparedFood" && raw.productType !== "NonAlcoholicBeverage")
    return invalid();
  const productReference = parseCatalogReference(raw.productReference);
  const brandReference = parseCatalogReference(raw.brandReference);
  const draft = parseProductVersion(raw.draft);
  if (
    draft.skus.some(
      (sku) => sku.productReference !== productReference || sku.brandReference !== brandReference,
    )
  )
    return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return Object.freeze({
    productReference,
    brandReference,
    internalCode: parseCatalogCode(raw.internalCode),
    productType: raw.productType,
    lifecycle: lifecycle(raw.lifecycle),
    aggregateVersion: positive(raw.aggregateVersion),
    draft,
    createdAt,
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
    updatedAt,
  });
}
export function transitionCatalogLifecycle(
  current: ProductLifecycle,
  target: ProductLifecycle,
): ProductLifecycle {
  const allowed: Readonly<Record<ProductLifecycle, readonly ProductLifecycle[]>> = {
    Draft: ["Active", "Archived"],
    Active: ["Suspended", "Discontinued"],
    Suspended: ["Active", "Discontinued"],
    Discontinued: ["Archived"],
    Archived: ["Draft", "Discontinued"],
  };
  if (!allowed[current].includes(target)) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return target;
}
export function resolveSkuSellable(product: ProductAggregate, skuReference: unknown): SkuSellable {
  const aggregate = parseProductAggregate(product);
  const reference = parseCatalogReference(skuReference);
  const sku = aggregate.draft.skus.find((candidate) => candidate.skuReference === reference);
  if (sku === undefined) throw new CatalogError("CATALOG_UNAVAILABLE");
  return Object.freeze({
    sellableReference: sku.skuReference,
    sellableType: "Sku",
    productReference: aggregate.productReference,
    brandReference: aggregate.brandReference,
    lifecycle: sku.lifecycle,
    catalogEligible: aggregate.lifecycle === "Active" && sku.lifecycle === "Active",
    unitOfSale: sku.unitOfSale,
    unitQuantity: sku.unitQuantity,
    taxClassificationReference: aggregate.draft.taxClassificationReference,
  });
}
