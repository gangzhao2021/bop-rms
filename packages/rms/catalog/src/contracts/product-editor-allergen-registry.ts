import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingDigest } from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseAllergenRegistryEntry, type AllergenRegistryEntry } from "./allergen-provenance.js";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  type ProductAggregate,
} from "./product.js";

export const productEditorAllergenRegistryFields = Object.freeze([
  "registryVersionReference",
  "brandReference",
  "jurisdictionCode",
  "policyDocumentDigest",
  "reviewedAt",
  "reviewerActorReference",
  "entries.allergenReference",
  "entries.code",
  "entries.localizedNames",
] as const);
export interface ProductEditorAllergenRegistryRequest {
  readonly profile: "CatalogProductEditorAllergenRegistryRequestV1";
  readonly intentKind: "EditorCreate" | "DraftReplace";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly aggregate: ProductAggregate;
  readonly registryVersionReference: string;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface ProductEditorAllergenRegistrySnapshot {
  readonly profile: "CatalogProductEditorAllergenRegistrySnapshotV1";
  readonly request: ProductEditorAllergenRegistryRequest;
  readonly registryVersionReference: string;
  readonly brandReference: string;
  readonly jurisdictionCode: string;
  readonly policyDocumentDigest: string;
  readonly reviewedAt: string;
  readonly reviewerActorReference: string;
  readonly entries: readonly AllergenRegistryEntry[];
  readonly vocabularyIntegrity: "Registered";
  readonly eligibility: "NotEvaluated";
  readonly observedAt: string;
  readonly validUntil: string;
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
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
export function parseProductEditorAllergenRegistryRequest(
  value: unknown,
): ProductEditorAllergenRegistryRequest {
  try {
    const r = exact(copyCategoryPersistenceValue(value), [
        "profile",
        "intentKind",
        "tenantReference",
        "brandReference",
        "actorReference",
        "operationReference",
        "aggregate",
        "registryVersionReference",
        "originalIntentDigest",
        "observedAt",
        "validUntil",
      ]),
      aggregate = parseProductAggregate(r.aggregate),
      brandReference = parseCatalogReference(r.brandReference),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogProductEditorAllergenRegistryRequestV1" ||
      (r.intentKind !== "EditorCreate" && r.intentKind !== "DraftReplace") ||
      aggregate.brandReference !== brandReference ||
      aggregate.draft.editorContent === undefined ||
      aggregate.draft.status !== "Draft" ||
      aggregate.updatedAt > observedAt ||
      (r.intentKind === "EditorCreate"
        ? aggregate.aggregateVersion !== 1 || aggregate.lifecycle !== "Draft"
        : aggregate.aggregateVersion < 2) ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      new TextEncoder().encode(canonicalizeRfc8785(aggregate)).byteLength > 8388608
    )
      return fail();
    return Object.freeze({
      profile: "CatalogProductEditorAllergenRegistryRequestV1",
      intentKind: r.intentKind,
      tenantReference: parseCatalogReference(r.tenantReference),
      brandReference,
      actorReference: parseCatalogReference(r.actorReference),
      operationReference: parseCatalogReference(r.operationReference),
      aggregate,
      registryVersionReference: parseCatalogReference(r.registryVersionReference),
      originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
/** Catalog vocabulary metadata only. No evidence assertion, safety approval or
 * Contains/free-from claim is constructed by this Product authoring source. */
export function buildProductEditorAllergenRegistrySnapshot(
  requestValue: unknown,
  factsValue: unknown,
): ProductEditorAllergenRegistrySnapshot {
  try {
    const request = parseProductEditorAllergenRegistryRequest(requestValue),
      facts = exact(copyCategoryPersistenceValue(factsValue), [
        "registryVersionReference",
        "brandReference",
        "jurisdictionCode",
        "policyDocumentDigest",
        "reviewedAt",
        "reviewerActorReference",
        "status",
        "entries",
      ]),
      reviewedAt = parseCatalogInstant(facts.reviewedAt);
    if (
      facts.registryVersionReference !== request.registryVersionReference ||
      facts.brandReference !== request.brandReference ||
      facts.status !== "Approved" ||
      reviewedAt > request.observedAt ||
      typeof facts.jurisdictionCode !== "string" ||
      !/^[A-Z][A-Z0-9_-]{1,31}$/.test(facts.jurisdictionCode) ||
      !Array.isArray(facts.entries) ||
      facts.entries.length > 10000 ||
      new TextEncoder().encode(canonicalizeRfc8785(facts)).byteLength > 8388608
    )
      return fail();
    const entries = Object.freeze(
      facts.entries
        .map((entry) => {
          const e = exact(entry, ["allergenReference", "code", "localizedNames"]);
          return parseAllergenRegistryEntry(
            e as unknown as AllergenRegistryEntry,
            request.aggregate.draft.defaultLocale,
          );
        })
        .sort((a, b) => a.allergenReference.localeCompare(b.allergenReference)),
    );
    if (
      new Set(entries.map((e) => e.allergenReference)).size !== entries.length ||
      new Set(entries.map((e) => e.code)).size !== entries.length
    )
      return fail();
    if (
      request.aggregate.draft.editorContent?.allergenReferences.some(
        (ref) => !entries.some((e) => e.allergenReference === ref),
      )
    )
      throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    const body = Object.freeze({
      profile: "CatalogProductEditorAllergenRegistrySnapshotV1" as const,
      request,
      registryVersionReference: request.registryVersionReference,
      brandReference: request.brandReference,
      jurisdictionCode: facts.jurisdictionCode,
      policyDocumentDigest: parsePublishingDigest(facts.policyDocumentDigest),
      reviewedAt,
      reviewerActorReference: parseCatalogReference(facts.reviewerActorReference),
      entries,
      vocabularyIntegrity: "Registered" as const,
      eligibility: "NotEvaluated" as const,
      observedAt: request.observedAt,
      validUntil: request.validUntil,
    });
    return Object.freeze({ ...body, digest: hash(body) });
  } catch (error) {
    if (error instanceof CatalogError && error.code === "CATALOG_LIFECYCLE_CONFLICT") throw error;
    return fail();
  }
}
