import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { buildCatalogProductEditorSnapshot } from "./product-editor-snapshot.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogCode,
  parseLocalizedNames,
  parseProductLifecycle,
  parseProductOptionBinding,
  parseProductAggregate,
  parseVariantSelections,
  type ProductOptionBinding,
} from "./product.js";
import type { ProductOptionContentRule } from "../domain/product-editor-content.js";

export interface ProductOptionPriceContextRequest {
  readonly productReference: string;
  readonly expectedAggregateVersion: number;
  readonly bindingReference: string;
  readonly optionReference: string | null;
}
export interface ProductOptionPriceContextSnapshot {
  readonly profile: "CatalogProductOptionPriceContextSnapshotV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly productReference: string;
  readonly aggregateVersion: number;
  readonly productVersionReference: string;
  readonly binding: ProductOptionBinding;
  readonly optionRule: ProductOptionContentRule;
  readonly skus: readonly Readonly<{
    skuReference: string;
    skuCode: string;
    lifecycle: ReturnType<typeof parseProductLifecycle>;
    localizedNames: Readonly<Record<string, string>>;
  }>[];
  readonly defaultLocale: string;
  readonly productSnapshotDigest: string;
  readonly aggregateDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.getPrototypeOf(r) !== Object.prototype ||
    Reflect.ownKeys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    return invalid();
  return r as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || value.length !== 71 || !/^sha256:[a-f0-9]{64}$/u.test(value))
    return invalid();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    return invalid();
  return value;
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export function parseProductOptionPriceContextRequest(
  value: unknown,
): ProductOptionPriceContextRequest {
  const r = closed(value, [
    "productReference",
    "expectedAggregateVersion",
    "bindingReference",
    "optionReference",
  ]);
  return Object.freeze({
    productReference: parseCatalogReference(r.productReference),
    expectedAggregateVersion: positive(r.expectedAggregateVersion),
    bindingReference: parseCatalogReference(r.bindingReference),
    optionReference: r.optionReference === null ? null : parseCatalogReference(r.optionReference),
  });
}
/** Structural projection only. Acquisition and current authority belong to its held owner. */
export function parseProductOptionPriceContextSnapshot(
  value: unknown,
): ProductOptionPriceContextSnapshot {
  const r = closed(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "actorReference",
    "productReference",
    "aggregateVersion",
    "productVersionReference",
    "binding",
    "optionRule",
    "skus",
    "defaultLocale",
    "productSnapshotDigest",
    "aggregateDigest",
    "contentDigest",
    "configurationDigest",
    "observedAt",
    "validUntil",
    "referenceEligibility",
    "publishValidation",
  ]);
  if (
    r.profile !== "CatalogProductOptionPriceContextSnapshotV1" ||
    r.referenceEligibility !== "NotEvaluated" ||
    r.publishValidation !== "Incomplete"
  )
    return invalid();
  const binding = parseProductOptionBinding(r.binding),
    rule = closed(r.optionRule, [
      "bindingReference",
      "versionResolution",
      "pricingRule",
      "conditionalRule",
      "conflictRule",
      "variantCondition",
    ]),
    locale = parseCatalogLocale(r.defaultLocale);
  if (
    rule.bindingReference !== binding.bindingReference ||
    (rule.versionResolution !== "Pinned" && rule.versionResolution !== "CurrentPublished")
  )
    return invalid();
  const reference = (v: unknown) => {
    if (v === null) return null;
    const item = closed(v, ["reference", "versionReference"]);
    return Object.freeze({
      reference: parseCatalogReference(item.reference),
      versionReference: parseCatalogReference(item.versionReference),
    });
  };
  if (!Array.isArray(r.skus) || r.skus.length > 10000) return invalid();
  const seen = new Set<string>();
  const skus = r.skus.map((v) => {
    const s = closed(v, ["skuReference", "skuCode", "lifecycle", "localizedNames"]),
      id = parseCatalogReference(s.skuReference);
    if (seen.has(id)) return invalid();
    seen.add(id);
    return {
      skuReference: id,
      skuCode: parseCatalogCode(s.skuCode),
      lifecycle: parseProductLifecycle(s.lifecycle),
      localizedNames: parseLocalizedNames(s.localizedNames, locale),
    };
  });
  if (
    [...binding.includedSkuReferences, ...binding.excludedSkuReferences].some((id) => !seen.has(id))
  )
    return invalid();
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return invalid();
  const result: ProductOptionPriceContextSnapshot = {
    profile: "CatalogProductOptionPriceContextSnapshotV1",
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
    productReference: parseCatalogReference(r.productReference),
    aggregateVersion: positive(r.aggregateVersion),
    productVersionReference: parseCatalogReference(r.productVersionReference),
    binding,
    optionRule: {
      bindingReference: binding.bindingReference,
      versionResolution: rule.versionResolution,
      pricingRule: reference(rule.pricingRule),
      conditionalRule: reference(rule.conditionalRule),
      conflictRule: reference(rule.conflictRule),
      variantCondition: parseVariantSelections(rule.variantCondition),
    },
    skus,
    defaultLocale: locale,
    productSnapshotDigest: digest(r.productSnapshotDigest),
    aggregateDigest: digest(r.aggregateDigest),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    observedAt,
    validUntil,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  };
  return immutable(result);
}
/** Complete aggregate is parsed only within Catalog; none is exposed by the projection. */
export function buildProductOptionPriceContextSnapshot(
  value: unknown,
  scope: { tenantReference: string; brandReference: string; actorReference: string },
  input: unknown,
  observation: string,
  validUntil: string,
): ProductOptionPriceContextSnapshot {
  const request = parseProductOptionPriceContextRequest(input),
    aggregate = parseProductAggregate(copyCategoryPersistenceValue(value));
  if (
    aggregate.productReference !== request.productReference ||
    aggregate.aggregateVersion !== request.expectedAggregateVersion
  )
    throw new CatalogError("CATALOG_VERSION_CONFLICT");
  const full = buildCatalogProductEditorSnapshot(
      aggregate,
      scope,
      {
        productReference: request.productReference,
        expectedAggregateVersion: request.expectedAggregateVersion,
      },
      observation,
    ),
    binding = aggregate.draft.optionBindings.find(
      (b) => b.bindingReference === request.bindingReference,
    ),
    rule = aggregate.draft.editorContent?.optionRules.find(
      (r) => r.bindingReference === request.bindingReference,
    );
  if (
    !binding ||
    !rule ||
    (request.optionReference !== null &&
      !binding.enabledOptionReferences.includes(parseCatalogReference(request.optionReference)))
  )
    throw new CatalogError("CATALOG_VERSION_CONFLICT");
  return parseProductOptionPriceContextSnapshot({
    profile: "CatalogProductOptionPriceContextSnapshotV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    actorReference: scope.actorReference,
    productReference: aggregate.productReference,
    aggregateVersion: aggregate.aggregateVersion,
    productVersionReference: aggregate.draft.versionReference,
    binding,
    optionRule: rule,
    skus: aggregate.draft.skus.map((s) => ({
      skuReference: s.skuReference,
      skuCode: s.skuCode,
      lifecycle: s.lifecycle,
      localizedNames: s.localizedNames,
    })),
    defaultLocale: aggregate.draft.defaultLocale,
    productSnapshotDigest: full.digest,
    aggregateDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(aggregate)),
    contentDigest: full.contentDigest,
    configurationDigest: full.configurationDigest,
    observedAt: observation,
    validUntil,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
}
