import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import type { RecordedProductReferenceConfiguration } from "./product-reference-history-source.js";
export const catalogInventorySkuReferenceMaximumRows = 10000;
export const catalogInventorySkuReferenceFields = Object.freeze([
  "sourceRevision",
  "productReference",
  "productVersionReference",
  "skuReference",
  "productAggregateVersion",
  "versionReference",
  "skuReferences",
  "categoryCoverage",
  "categoryReferences",
  "primaryCategoryReference",
  "taxClassificationReference",
  "bindingReference",
  "optionSetReference",
  "optionSetVersionReference",
  "enabledOptionReferences",
  "includedSkuReferences",
  "excludedSkuReferences",
  "channelCodes",
  "configurationDigest",
] as const);
export const catalogInventorySkuReferencePermissions = Object.freeze([
  "catalog.product.read",
  "catalog.sku.read",
] as const);
export interface CatalogInventorySkuReferenceRequest {
  readonly purposeCode: "INVENTORY_FINISHED_GOOD_SKU_SOURCE_READ";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly consumerIntentDigest: string;
  readonly productReference: string;
  readonly productVersionReference: string;
  readonly skuReference: string;
  readonly expectedConfigurationDigest: string | null;
}
export interface CatalogInventorySkuReferenceSnapshot {
  readonly request: CatalogInventorySkuReferenceRequest;
  readonly profile: "CatalogCurrentDraftSkuReferencesV1";
  readonly coverage: "CurrentDraftReferenceConfiguration";
  readonly consistency: "HeldSupportedProductWriters";
  readonly applicability: "Unavailable";
  readonly sourceRevision: string;
  readonly productAggregateVersion: number;
  readonly configuration: RecordedProductReferenceConfiguration;
  readonly configurationDigest: string;
  readonly observedAt: string;
  readonly digest: string;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
function exact(v: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== fields.length
  )
    return fail();
  return v as Record<string, unknown>;
}
function hash(v: unknown): string {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v) ? v : fail();
}
export function parseCatalogInventorySkuReferenceRequest(
  value: unknown,
): CatalogInventorySkuReferenceRequest {
  try {
    const r = exact(copyCategoryPersistenceValue(value), [
      "purposeCode",
      "tenantReference",
      "brandReference",
      "actorReference",
      "operationReference",
      "consumerIntentDigest",
      "productReference",
      "productVersionReference",
      "skuReference",
      "expectedConfigurationDigest",
    ]);
    if (r.purposeCode !== "INVENTORY_FINISHED_GOOD_SKU_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      tenantReference: parseCatalogReference(r.tenantReference),
      brandReference: parseCatalogReference(r.brandReference),
      actorReference: parseCatalogReference(r.actorReference),
      operationReference: parseCatalogReference(r.operationReference),
      consumerIntentDigest: hash(r.consumerIntentDigest),
      productReference: parseCatalogReference(r.productReference),
      productVersionReference: parseCatalogReference(r.productVersionReference),
      skuReference: parseCatalogReference(r.skuReference),
      expectedConfigurationDigest:
        r.expectedConfigurationDigest === null ? null : hash(r.expectedConfigurationDigest),
    });
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}
function configuration(
  value: unknown,
  request: CatalogInventorySkuReferenceRequest,
): RecordedProductReferenceConfiguration {
  const r = exact(value, [
    "versionReference",
    "skuReferences",
    "categoryCoverage",
    "categoryReferences",
    "primaryCategoryReference",
    "taxClassificationReference",
    "bindings",
  ]);
  let budget = catalogInventorySkuReferenceMaximumRows;
  const list = (
    value: unknown,
    parse: (v: unknown) => string = parseCatalogReference,
  ): readonly string[] => {
    if (!Array.isArray(value) || value.length > 1000 || (budget -= value.length) < 0) return fail();
    const values = value.map(parse);
    if (new Set(values).size !== values.length) return fail();
    return Object.freeze(values.sort());
  };
  const versionReference = parseCatalogReference(r.versionReference),
    skuReferences = list(r.skuReferences),
    primaryCategoryReference =
      r.primaryCategoryReference === null
        ? null
        : parseCatalogReference(r.primaryCategoryReference),
    taxClassificationReference =
      r.taxClassificationReference === null
        ? null
        : parseCatalogReference(r.taxClassificationReference);
  if (
    versionReference !== request.productVersionReference ||
    !skuReferences.includes(request.skuReference) ||
    (r.categoryCoverage !== "Known" && r.categoryCoverage !== "Unavailable")
  )
    return fail();
  const categoryReferences = r.categoryCoverage === "Known" ? list(r.categoryReferences) : null;
  if (
    (r.categoryCoverage === "Unavailable" &&
      (r.categoryReferences !== null || primaryCategoryReference !== null)) ||
    (primaryCategoryReference !== null && !categoryReferences?.includes(primaryCategoryReference))
  )
    return fail();
  if (!Array.isArray(r.bindings) || r.bindings.length > 1000 || (budget -= r.bindings.length) < 0)
    return fail();
  const seen = new Set<string>();
  const bindings = r.bindings
    .map((value) => {
      const b = exact(value, [
          "bindingReference",
          "optionSetReference",
          "optionSetVersionReference",
          "enabledOptionReferences",
          "includedSkuReferences",
          "excludedSkuReferences",
          "channelCodes",
        ]),
        bindingReference = parseCatalogReference(b.bindingReference),
        includedSkuReferences = list(b.includedSkuReferences),
        excludedSkuReferences = list(b.excludedSkuReferences);
      if (
        seen.has(bindingReference) ||
        [...includedSkuReferences, ...excludedSkuReferences].some(
          (id) => !skuReferences.includes(id),
        ) ||
        includedSkuReferences.some((id) => excludedSkuReferences.includes(id))
      )
        return fail();
      seen.add(bindingReference);
      return Object.freeze({
        bindingReference,
        optionSetReference: parseCatalogReference(b.optionSetReference),
        optionSetVersionReference: parseCatalogReference(b.optionSetVersionReference),
        enabledOptionReferences: list(b.enabledOptionReferences),
        includedSkuReferences,
        excludedSkuReferences,
        channelCodes: list(b.channelCodes, parseCatalogCode),
      });
    })
    .sort((a, b) => a.bindingReference.localeCompare(b.bindingReference));
  return Object.freeze({
    versionReference,
    skuReferences,
    categoryCoverage: r.categoryCoverage,
    categoryReferences,
    primaryCategoryReference,
    taxClassificationReference,
    bindings: Object.freeze(bindings),
  });
}
export function buildCatalogInventorySkuReferenceSnapshot(
  value: unknown,
  input: CatalogInventorySkuReferenceRequest,
  now: string,
): CatalogInventorySkuReferenceSnapshot {
  try {
    const request = parseCatalogInventorySkuReferenceRequest(input),
      r = exact(copyCategoryPersistenceValue(value), [
        "brandReference",
        "productReference",
        "skuReference",
        "sourceRevision",
        "productAggregateVersion",
        "observedAt",
        "precise",
        "configuration",
      ]),
      observedAt = parseCatalogInstant(r.observedAt),
      at = parseCatalogInstant(now);
    if (
      r.brandReference !== request.brandReference ||
      r.productReference !== request.productReference ||
      r.skuReference !== request.skuReference ||
      r.precise !== true ||
      at < observedAt ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      typeof r.sourceRevision !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(r.sourceRevision) ||
      BigInt(r.sourceRevision) > 9223372036854775807n ||
      typeof r.productAggregateVersion !== "number" ||
      !Number.isSafeInteger(r.productAggregateVersion) ||
      r.productAggregateVersion < 1 ||
      r.productAggregateVersion > 2147483647
    )
      return fail();
    const graph = configuration(r.configuration, request),
      configurationDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(graph));
    if (
      request.expectedConfigurationDigest !== null &&
      request.expectedConfigurationDigest !== configurationDigest
    )
      return fail();
    const content = {
      request,
      profile: "CatalogCurrentDraftSkuReferencesV1" as const,
      coverage: "CurrentDraftReferenceConfiguration" as const,
      consistency: "HeldSupportedProductWriters" as const,
      applicability: "Unavailable" as const,
      sourceRevision: r.sourceRevision,
      productAggregateVersion: r.productAggregateVersion,
      configuration: graph,
      configurationDigest,
    };
    return Object.freeze({
      ...content,
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(content)),
    });
  } catch {
    return fail();
  }
}
export function parseCatalogInventorySkuReferenceSnapshot(
  value: unknown,
  input: CatalogInventorySkuReferenceRequest,
  now: string,
): CatalogInventorySkuReferenceSnapshot {
  try {
    const r = exact(copyCategoryPersistenceValue(value), [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "sourceRevision",
        "productAggregateVersion",
        "configuration",
        "configurationDigest",
        "observedAt",
        "digest",
      ]),
      request = parseCatalogInventorySkuReferenceRequest(input);
    const built = buildCatalogInventorySkuReferenceSnapshot(
      {
        brandReference: request.brandReference,
        productReference: request.productReference,
        skuReference: request.skuReference,
        sourceRevision: r.sourceRevision,
        productAggregateVersion: r.productAggregateVersion,
        observedAt: r.observedAt,
        precise: true,
        configuration: r.configuration,
      },
      request,
      now,
    );
    if (canonicalizeRfc8785(built) !== canonicalizeRfc8785(r)) return fail();
    return built;
  } catch {
    return fail();
  }
}
