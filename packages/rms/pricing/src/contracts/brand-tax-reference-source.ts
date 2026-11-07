import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import { parseTenantStoreReferenceSnapshot, type TenantStoreReferenceSnapshot } from "@bop/tenant";
import { parsePricingReference } from "../domain/money-tax-contract.js";
import {
  parsePriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceRequest,
} from "./price-book-reference-source.js";
import {
  parseTaxConfigurationReferenceSourceSnapshot,
  type TaxConfigurationReferenceSourceSnapshot,
} from "./tax-configuration-reference-source.js";
export const maximumBrandTaxRootReferences = 10_000;
export const brandTaxReferenceSourceFields = Object.freeze([
  "configurationReference",
  "storeReference",
  "present",
  "aggregateVersion",
  "currentVersionReference",
  "generation",
  "referenceCount",
] as const);
export class BrandTaxReferenceSourceError extends Error {
  readonly code = "BRAND_TAX_REFERENCE_SOURCE_UNAVAILABLE";
  constructor() {
    super("brand tax references are unavailable");
    this.name = "BrandTaxReferenceSourceError";
  }
}
const fail = (): never => {
  throw new BrandTaxReferenceSourceError();
};
export interface BrandTaxRootScopeReference {
  readonly configurationReference: string;
  readonly storeReference: string;
  readonly present: boolean;
  readonly aggregateVersion: string;
  readonly currentVersionReference: string | null;
}
export interface BrandTaxReferenceSnapshot {
  readonly profile: "BrandTaxConfigurationRulesV1";
  readonly request: PriceBookReferenceSourceRequest;
  readonly scopeCoverage: "AllRegisteredStores";
  readonly consistency: "TransactionHeldSources";
  readonly observedAt: string;
  readonly digest: string;
  readonly storeInventory: TenantStoreReferenceSnapshot;
  readonly generation: string;
  readonly referenceCount: string;
  readonly rootScope: readonly BrandTaxRootScopeReference[];
  readonly stores: readonly TaxConfigurationReferenceSourceSnapshot[];
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
function integer(value: unknown, zero: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > 19 ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n ||
    (!zero && value === "0")
  )
    return fail();
  return value;
}
/** Current complete registry/rules, retaining retired root references. Never tax
 * applicability, historical legal completeness or a resolved Brand default. */
export function buildBrandTaxReferenceSnapshot(
  rawInput: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): BrandTaxReferenceSnapshot {
  try {
    now = parseEffectivePeriodInstant(now);
    const request = parsePriceBookReferenceSourceRequest(input);
    const raw = closed(rawInput, [
      "storeInventory",
      "generation",
      "referenceCount",
      "rootScope",
      "stores",
    ]);
    const roster = parseTenantStoreReferenceSnapshot(raw.storeInventory);
    if (
      roster.brandReference !== request.brandReference ||
      roster.originalIntentDigest !== request.catalogIntentDigest
    )
      return fail();
    const generation = integer(raw.generation, true),
      referenceCount = integer(raw.referenceCount, true);
    const registered = new Set(roster.references.map((s) => s.storeReference));
    const scope = array(raw.rootScope, maximumBrandTaxRootReferences);
    if (BigInt(referenceCount) !== BigInt(scope.length)) return fail();
    const keys = new Set<string>(),
      presentIds = new Set<string>();
    let previous = "";
    const rootScope = Object.freeze(
      scope.map((value) => {
        const r = closed(value, [
          "configurationReference",
          "storeReference",
          "present",
          "aggregateVersion",
          "currentVersionReference",
        ]);
        const configurationReference = parsePricingReference(r.configurationReference),
          storeReference = parsePricingReference(r.storeReference),
          key = storeReference + ":" + configurationReference;
        if (
          !registered.has(storeReference) ||
          typeof r.present !== "boolean" ||
          keys.has(key) ||
          key <= previous
        )
          return fail();
        keys.add(key);
        previous = key;
        const aggregateVersion = integer(r.aggregateVersion, false);
        if (BigInt(aggregateVersion) > 2147483647n) return fail();
        if (r.present) {
          if (presentIds.has(configurationReference)) return fail();
          presentIds.add(configurationReference);
        }
        return Object.freeze({
          configurationReference,
          storeReference,
          present: r.present,
          aggregateVersion,
          currentVersionReference:
            r.currentVersionReference === null
              ? null
              : parsePricingReference(r.currentVersionReference),
        });
      }),
    );
    const sources = array(raw.stores, 10_000);
    if (sources.length !== registered.size) return fail();
    let total = 0;
    const stores = Object.freeze(
      sources.map((value, i) => {
        const store = roster.references[i];
        if (!store) return fail();
        const source = parseTaxConfigurationReferenceSourceSnapshot(
          value,
          { ...request, storeReference: store.storeReference },
          now,
        );
        const expected = rootScope.filter(
          (r) => r.storeReference === store.storeReference && r.present,
        );
        if (source.roots.length !== expected.length) return fail();
        for (const r of source.roots) {
          const e = expected.find((e) => e.configurationReference === r.configurationReference);
          if (
            !e ||
            e.aggregateVersion !== String(r.aggregateVersion) ||
            e.currentVersionReference !== r.currentVersionReference
          )
            return fail();
        }
        total +=
          source.roots.length + source.versions.reduce((sum, v) => sum + 1 + v.rules.length, 0);
        if (total > 100_000) return fail();
        return source;
      }),
    );
    const content = {
      profile: "BrandTaxConfigurationRulesV1" as const,
      request,
      scopeCoverage: "AllRegisteredStores" as const,
      consistency: "TransactionHeldSources" as const,
      observedAt: roster.observedAt,
      storeInventory: roster,
      generation,
      referenceCount,
      rootScope,
      stores,
    };
    if (
      Date.parse(now) < Date.parse(roster.observedAt) ||
      Date.parse(now) - Date.parse(roster.observedAt) > 5000
    )
      return fail();
    return Object.freeze({
      ...content,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(content)),
    });
  } catch {
    return fail();
  }
}
export function parseBrandTaxReferenceSnapshot(
  value: unknown,
  request: PriceBookReferenceSourceRequest,
  now: string,
): BrandTaxReferenceSnapshot {
  try {
    const r = closed(value, [
      "profile",
      "request",
      "scopeCoverage",
      "consistency",
      "observedAt",
      "digest",
      "storeInventory",
      "generation",
      "referenceCount",
      "rootScope",
      "stores",
    ]);
    const parsed = buildBrandTaxReferenceSnapshot(
      {
        storeInventory: r.storeInventory,
        generation: r.generation,
        referenceCount: r.referenceCount,
        rootScope: r.rootScope,
        stores: r.stores,
      },
      request,
      now,
    );
    if (canonicalizeRfc8785(parsed) !== canonicalizeRfc8785(value)) return fail();
    return parsed;
  } catch {
    return fail();
  }
}
