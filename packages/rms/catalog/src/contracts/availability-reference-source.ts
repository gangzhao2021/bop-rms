import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
} from "./product.js";
export const availabilityReferenceSourceMaximumRows = 10000;
export const availabilityReferenceSourceFields = Object.freeze([
  "generation",
  "ruleReference",
  "sellableType",
  "sellableReference",
  "storeReference",
  "aggregateVersion",
  "lifecycle",
  "effectiveFrom",
  "effectiveUntil",
  "updatedAt",
] as const);
export interface AvailabilityReferenceSourceRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ";
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
}
export interface AvailabilityStoredRuleReference {
  readonly ruleReference: string;
  readonly brandReference: string;
  readonly sellableType: "Product" | "Sku" | "Bundle";
  readonly sellableReference: string;
  readonly storeReference: string | null;
  readonly aggregateVersion: number;
  readonly lifecycle: "Draft" | "Active" | "Inactive" | "Archived";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly updatedAt: string;
}
export interface AvailabilityReferenceSourceSnapshot {
  readonly profile: "BrandAvailabilityRuleReferencesV1";
  readonly request: AvailabilityReferenceSourceRequest;
  readonly consistency: "StatementSnapshot";
  readonly coverage: "CompleteStoredReferences";
  readonly applicability: "Unavailable";
  readonly generation: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly rules: readonly AvailabilityStoredRuleReference[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function array(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > availabilityReferenceSourceMaximumRows ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
const requestFields = [
  "purposeCode",
  "brandReference",
  "actorReference",
  "operationReference",
  "catalogIntentDigest",
] as const;
function digest(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
export function parseAvailabilityReferenceSourceRequest(
  value: unknown,
): AvailabilityReferenceSourceRequest {
  try {
    const r = exact(value, requestFields);
    if (r.purposeCode !== "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      brandReference: parseCatalogReference(r.brandReference),
      actorReference: parseCatalogReference(r.actorReference),
      operationReference: parseCatalogReference(r.operationReference),
      catalogIntentDigest: digest(r.catalogIntentDigest),
    });
  } catch {
    return fail();
  }
}
export function buildAvailabilityReferenceSourceSnapshot(
  value: unknown,
  input: AvailabilityReferenceSourceRequest,
  now: string,
): AvailabilityReferenceSourceSnapshot {
  try {
    const request = parseAvailabilityReferenceSourceRequest(input),
      r = exact(value, ["generation", "rootCount", "observedAt", "rules"]),
      observedAt = parseCatalogInstant(r.observedAt),
      at = Date.parse(parseCatalogInstant(now)),
      raw = array(r.rules);
    if (
      typeof r.rootCount !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(r.rootCount) ||
      r.rootCount !== String(raw.length) ||
      at < Date.parse(observedAt) ||
      at - Date.parse(observedAt) > 5000
    )
      return fail();
    const generation = r.generation === null && raw.length === 0 ? "0" : r.generation;
    if (
      typeof generation !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(generation) ||
      generation.length > 19 ||
      BigInt(generation) > 9223372036854775807n
    )
      return fail();
    const ids = new Set<string>();
    const rules = raw
      .map((value) => {
        const v = exact(value, [
            "ruleReference",
            "brandReference",
            "sellableType",
            "sellableReference",
            "storeReference",
            "aggregateVersion",
            "lifecycle",
            "effectiveFrom",
            "effectiveUntil",
            "updatedAt",
            "precise",
          ]),
          ruleReference = parseCatalogReference(v.ruleReference),
          brandReference = parseCatalogReference(v.brandReference),
          effectiveFrom = parseCatalogInstant(v.effectiveFrom),
          effectiveUntil = v.effectiveUntil === null ? null : parseCatalogInstant(v.effectiveUntil),
          updatedAt = parseCatalogInstant(v.updatedAt);
        if (
          ids.has(ruleReference) ||
          brandReference !== request.brandReference ||
          v.precise !== true ||
          (v.sellableType !== "Product" &&
            v.sellableType !== "Sku" &&
            v.sellableType !== "Bundle") ||
          (v.lifecycle !== "Draft" &&
            v.lifecycle !== "Active" &&
            v.lifecycle !== "Inactive" &&
            v.lifecycle !== "Archived") ||
          !Number.isSafeInteger(v.aggregateVersion) ||
          (v.aggregateVersion as number) < 1 ||
          (v.aggregateVersion as number) > 2147483647 ||
          updatedAt > observedAt ||
          (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
        )
          return fail();
        ids.add(ruleReference);
        return Object.freeze({
          ruleReference,
          brandReference,
          sellableType: v.sellableType,
          sellableReference: parseCatalogReference(v.sellableReference),
          storeReference:
            v.storeReference === null ? null : parseCatalogReference(v.storeReference),
          aggregateVersion: v.aggregateVersion as number,
          lifecycle: v.lifecycle,
          effectiveFrom,
          effectiveUntil,
          updatedAt,
        });
      })
      .sort((a, b) => a.ruleReference.localeCompare(b.ruleReference));
    const body = { request, generation, rules: Object.freeze(rules) };
    return Object.freeze({
      ...body,
      profile: "BrandAvailabilityRuleReferencesV1",
      consistency: "StatementSnapshot",
      coverage: "CompleteStoredReferences",
      applicability: "Unavailable",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    });
  } catch {
    return fail();
  }
}
/** Parsing validates data only; the owning callback and current authority supply its lifetime. */
export function parseAvailabilityReferenceSourceSnapshot(
  value: unknown,
  input: AvailabilityReferenceSourceRequest,
  now: string,
): AvailabilityReferenceSourceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "generation",
        "rules",
        "profile",
        "consistency",
        "coverage",
        "applicability",
        "observedAt",
        "digest",
      ]),
      request = parseAvailabilityReferenceSourceRequest(r.request),
      expected = parseAvailabilityReferenceSourceRequest(input);
    if (
      canonicalizeRfc8785(request) !== canonicalizeRfc8785(expected) ||
      r.profile !== "BrandAvailabilityRuleReferencesV1" ||
      r.consistency !== "StatementSnapshot" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.applicability !== "Unavailable" ||
      typeof r.generation !== "string"
    )
      return fail();
    const rules = array(r.rules).map((value) => ({
      ...exact(value, [
        "ruleReference",
        "brandReference",
        "sellableType",
        "sellableReference",
        "storeReference",
        "aggregateVersion",
        "lifecycle",
        "effectiveFrom",
        "effectiveUntil",
        "updatedAt",
      ]),
      precise: true,
    }));
    const result = buildAvailabilityReferenceSourceSnapshot(
      {
        generation: r.generation,
        rootCount: String(rules.length),
        observedAt: r.observedAt,
        rules,
      },
      expected,
      now,
    );
    if (result.digest !== digest(r.digest)) return fail();
    return result;
  } catch {
    return fail();
  }
}
