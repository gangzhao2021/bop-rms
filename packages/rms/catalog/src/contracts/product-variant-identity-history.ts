import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingDigest } from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  type ProductAggregate,
} from "./product.js";

export const productVariantHistoryFields = Object.freeze([
  "productReference",
  "aggregateVersion",
  "sku.variantSelections",
  "editorContent.variantDimensions.identity",
  "editorContent.variantDimensions.code",
] as const);
export interface ProductVariantIdentityHistoryRequest {
  readonly productReference: string;
  readonly expectedAggregateVersion: number;
  readonly originalIntentDigest: string;
}
export interface ProductVariantIdentityHistorySnapshot {
  readonly profile: "CatalogProductVariantIdentityHistoryV1";
  readonly brandReference: string;
  readonly productReference: string;
  readonly aggregateVersion: number;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly eligibility: "NotEvaluated";
  readonly used: readonly {
    readonly dimensionReference: string;
    readonly dimensionCode: string | null;
    readonly valueReference: string;
    readonly valueCode: string | null;
  }[];
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const d = descriptors[key];
      if (!d?.enumerable || !("value" in d)) return fail();
      return [key, d.value];
    }),
  );
}
export function parseProductVariantIdentityHistoryRequest(
  value: unknown,
): ProductVariantIdentityHistoryRequest {
  const r = exact(value, ["productReference", "expectedAggregateVersion", "originalIntentDigest"]);
  if (
    !Number.isSafeInteger(r.expectedAggregateVersion) ||
    (r.expectedAggregateVersion as number) < 1 ||
    (r.expectedAggregateVersion as number) > 1000
  )
    return fail();
  return Object.freeze({
    productReference: parseCatalogReference(r.productReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number,
    originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
  });
}
/** Owner-only derivation. Public legacy bytes are unchanged. */
export function buildProductVariantIdentityHistory(
  value: unknown,
  brandValue: string,
  requestValue: ProductVariantIdentityHistoryRequest,
): ProductVariantIdentityHistorySnapshot {
  return buildVerifiedProductVariantIdentityHistory(value, brandValue, requestValue).variantHistory;
}
/** Catalog-internal shared verification. Full aggregates never leave an owning
 * source; the qualification companion derives only hashes and reference graphs.
 * Do not export this kernel from the module public index. */
export function buildVerifiedProductVariantIdentityHistory(
  value: unknown,
  brandValue: string,
  requestValue: ProductVariantIdentityHistoryRequest,
) {
  const request = parseProductVariantIdentityHistoryRequest(requestValue),
    brandReference = parseCatalogReference(brandValue),
    r = exact(value, ["aggregateVersion", "observedAt", "history"]),
    observedAt = parseCatalogInstant(r.observedAt);
  if (
    r.aggregateVersion !== request.expectedAggregateVersion ||
    !Array.isArray(r.history) ||
    r.history.length !== request.expectedAggregateVersion
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(r.history);
  if (Reflect.ownKeys(r.history).length !== r.history.length + 1) return fail();
  const used = new Map<string, ProductVariantIdentityHistorySnapshot["used"][number]>(),
    operations = new Set<string>();
  let priorTime = "",
    createdAt = "",
    encodedSize = 0;
  const dimensionCodes = new Map<string, string>();
  const verified: {
    readonly aggregate: ProductAggregate;
    readonly operationReference: string;
    readonly snapshotDigest: string;
  }[] = [];
  for (let i = 0; i < r.history.length; i++) {
    const d = descriptors[String(i)];
    if (!d || !("value" in d)) return fail();
    const row = exact(d.value, ["aggregate", "operationReference", "snapshotDigest", "coherent"]);
    if (row.coherent !== true) return fail();
    const aggregate = parseProductAggregate(copyCategoryPersistenceValue(row.aggregate)),
      operation = parseCatalogReference(row.operationReference);
    encodedSize += canonicalizeRfc8785(aggregate).length;
    if (encodedSize > 8388608) return fail();
    if (
      operations.has(operation) ||
      row.snapshotDigest !== hash(aggregate) ||
      aggregate.aggregateVersion !== i + 1 ||
      aggregate.brandReference !== brandReference ||
      aggregate.productReference !== request.productReference ||
      aggregate.updatedAt < priorTime ||
      aggregate.updatedAt > observedAt ||
      (i > 0 && aggregate.createdAt !== createdAt)
    )
      return fail();
    verified.push(
      Object.freeze({ aggregate, operationReference: operation, snapshotDigest: hash(aggregate) }),
    );
    operations.add(operation);
    priorTime = aggregate.updatedAt;
    createdAt = aggregate.createdAt;
    for (const sku of aggregate.draft.skus)
      for (const selection of sku.variantSelections) {
        const dimension = aggregate.draft.editorContent?.variantDimensions.find(
            (v) => v.dimensionReference === selection.dimensionReference,
          ),
          member = dimension?.values.find((v) => v.valueReference === selection.valueReference),
          key = selection.dimensionReference + ":" + selection.valueReference;
        const old = used.get(key);
        const knownDimensionCode = dimensionCodes.get(selection.dimensionReference);
        if (dimension && knownDimensionCode !== undefined && dimension.code !== knownDimensionCode)
          return fail();
        if (dimension) dimensionCodes.set(selection.dimensionReference, dimension.code);
        if (
          old &&
          ((old.dimensionCode !== null && dimension && old.dimensionCode !== dimension.code) ||
            (old.valueCode !== null && member && old.valueCode !== member.code))
        )
          return fail();
        used.set(
          key,
          Object.freeze({
            ...selection,
            dimensionCode: old?.dimensionCode ?? dimension?.code ?? null,
            valueCode: old?.valueCode ?? member?.code ?? null,
          }),
        );
        if (used.size > 10000) return fail();
      }
  }
  const body = {
    profile: "CatalogProductVariantIdentityHistoryV1" as const,
    brandReference,
    productReference: request.productReference,
    aggregateVersion: request.expectedAggregateVersion,
    originalIntentDigest: request.originalIntentDigest,
    observedAt,
    eligibility: "NotEvaluated" as const,
    used: Object.freeze(
      [...used.values()].sort((a, b) =>
        (a.dimensionReference + ":" + a.valueReference).localeCompare(
          b.dimensionReference + ":" + b.valueReference,
        ),
      ),
    ),
  };
  return Object.freeze({
    variantHistory: Object.freeze({ ...body, digest: hash(body) }),
    operations: Object.freeze(verified),
  });
}
export function parseProductVariantIdentityHistorySnapshot(
  value: unknown,
): ProductVariantIdentityHistorySnapshot {
  const r = exact(copyCategoryPersistenceValue(value), [
    "profile",
    "brandReference",
    "productReference",
    "aggregateVersion",
    "originalIntentDigest",
    "observedAt",
    "eligibility",
    "used",
    "digest",
  ]);
  const request = parseProductVariantIdentityHistoryRequest({
    productReference: r.productReference,
    expectedAggregateVersion: r.aggregateVersion,
    originalIntentDigest: r.originalIntentDigest,
  });
  if (
    r.profile !== "CatalogProductVariantIdentityHistoryV1" ||
    r.eligibility !== "NotEvaluated" ||
    !Array.isArray(r.used) ||
    r.used.length > 10000
  )
    return fail();
  const used = Object.freeze(
    r.used.map((v) => {
      const item = exact(v, ["dimensionReference", "dimensionCode", "valueReference", "valueCode"]);
      return Object.freeze({
        dimensionReference: parseCatalogReference(item.dimensionReference),
        dimensionCode: item.dimensionCode === null ? null : parseCatalogCode(item.dimensionCode),
        valueReference: parseCatalogReference(item.valueReference),
        valueCode: item.valueCode === null ? null : parseCatalogCode(item.valueCode),
      });
    }),
  );
  const keys = used.map((v) => v.dimensionReference + ":" + v.valueReference);
  if (keys.some((v, i) => i > 0 && v <= (keys[i - 1] ?? ""))) return fail();
  const body = {
    profile: r.profile,
    brandReference: parseCatalogReference(r.brandReference),
    productReference: request.productReference,
    aggregateVersion: request.expectedAggregateVersion,
    originalIntentDigest: request.originalIntentDigest,
    observedAt: parseCatalogInstant(r.observedAt),
    eligibility: r.eligibility,
    used,
  };
  if (r.digest !== hash(body)) return fail();
  return Object.freeze({ ...body, digest: r.digest }) as ProductVariantIdentityHistorySnapshot;
}
/** Current owning history preserves used identities, not physical SKU readiness. */
export function assertProductVariantIdentityHistory(
  candidateValue: unknown,
  snapshotValue: unknown,
): void {
  const candidate = parseProductAggregate(copyCategoryPersistenceValue(candidateValue)),
    snapshot = parseProductVariantIdentityHistorySnapshot(snapshotValue);
  if (
    candidate.brandReference !== snapshot.brandReference ||
    candidate.productReference !== snapshot.productReference ||
    (candidate.aggregateVersion !== snapshot.aggregateVersion &&
      candidate.aggregateVersion !== snapshot.aggregateVersion + 1) ||
    !candidate.draft.editorContent
  )
    return fail();
  for (const old of snapshot.used) {
    const dimension = candidate.draft.editorContent.variantDimensions.find(
        (v) => v.dimensionReference === old.dimensionReference,
      ),
      member = dimension?.values.find((v) => v.valueReference === old.valueReference);
    if (
      !dimension ||
      !member ||
      (old.dimensionCode !== null && dimension.code !== old.dimensionCode) ||
      (old.valueCode !== null && member.code !== old.valueCode)
    )
      return fail();
  }
}

/** Creation is a separate proof: no recorded Product exists yet. It is never
 * represented as an empty existing-version history or publication readiness. */
export interface ProductVariantCreationRequest {
  readonly profile: "CatalogProductVariantCreationRequestV1";
  readonly operationReference: string;
  readonly aggregate: ProductAggregate;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export const productVariantCreationFields = Object.freeze([
  "productReference",
  "versionReference",
  "aggregateSnapshotDigest",
  "operationReference",
  "priorProductIdentity",
  "priorOperationIdentity",
  "priorIdentityHistory",
  "editorContent.variantDimensions.identity",
  "editorContent.variantDimensions.code",
] as const);
export interface ProductVariantCreationAbsence {
  readonly profile: "CatalogProductVariantCreationAbsenceV1";
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly operationReference: string;
  readonly aggregateSnapshotDigest: string;
  readonly originalIntentDigest: string;
  readonly absence: "NoRecordedProductOrOperation";
  readonly eligibility: "NotEvaluated";
  readonly observedAt: string;
  readonly validUntil: string;
  readonly digest: string;
}
export function parseProductVariantCreationRequest(value: unknown): ProductVariantCreationRequest {
  try {
    const r = exact(copyCategoryPersistenceValue(value), [
        "profile",
        "operationReference",
        "aggregate",
        "originalIntentDigest",
        "observedAt",
        "validUntil",
      ]),
      aggregate = parseProductAggregate(r.aggregate),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogProductVariantCreationRequestV1" ||
      aggregate.aggregateVersion !== 1 ||
      aggregate.lifecycle !== "Draft" ||
      aggregate.draft.status !== "Draft" ||
      aggregate.draft.baseVersionReference !== null ||
      aggregate.createdAt !== aggregate.updatedAt ||
      aggregate.createdAt > observedAt ||
      aggregate.draft.createdAt !== aggregate.createdAt ||
      aggregate.draft.updatedAt !== aggregate.createdAt ||
      aggregate.draft.editorContent === undefined ||
      aggregate.draft.skus.length > 1 ||
      aggregate.draft.skus.some(
        (sku) =>
          sku.variantSelections.length !== 0 ||
          sku.lifecycle !== "Draft" ||
          sku.createdAt !== aggregate.createdAt ||
          sku.createdByActorReference !== aggregate.createdByActorReference,
      ) ||
      (aggregate.draft.skus.length !== 0 &&
        (aggregate.draft.editorContent.variantDimensions.length !== 0 ||
          aggregate.draft.editorContent.variantCombinations.length !== 0)) ||
      aggregate.draft.optionBindings.length !== 0 ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      new TextEncoder().encode(canonicalizeRfc8785(aggregate)).byteLength > 8 * 1024 * 1024
    )
      return fail();
    return Object.freeze({
      profile: "CatalogProductVariantCreationRequestV1",
      operationReference: parseCatalogReference(r.operationReference),
      aggregate,
      originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
/** Structural derivation only. Only the owning held SQL callback establishes
 * that these absence observations were actually made under the writer locks. */
export function buildProductVariantCreationAbsence(
  value: unknown,
  requestValue: unknown,
): ProductVariantCreationAbsence {
  const request = parseProductVariantCreationRequest(requestValue),
    r = exact(copyCategoryPersistenceValue(value), [
      "productExists",
      "operationExists",
      "historyExists",
      "observedAt",
    ]),
    observedAt = parseCatalogInstant(r.observedAt);
  if (
    r.productExists !== false ||
    r.operationExists !== false ||
    r.historyExists !== false ||
    observedAt < request.observedAt ||
    observedAt >= request.validUntil
  )
    return fail();
  const body = Object.freeze({
    profile: "CatalogProductVariantCreationAbsenceV1" as const,
    brandReference: request.aggregate.brandReference,
    productReference: request.aggregate.productReference,
    versionReference: request.aggregate.draft.versionReference,
    operationReference: request.operationReference,
    aggregateSnapshotDigest: hash(request.aggregate),
    originalIntentDigest: request.originalIntentDigest,
    absence: "NoRecordedProductOrOperation" as const,
    eligibility: "NotEvaluated" as const,
    observedAt,
    validUntil: request.validUntil,
  });
  return Object.freeze({ ...body, digest: hash(body) });
}
export function parseProductVariantCreationAbsence(value: unknown): ProductVariantCreationAbsence {
  try {
    const r = exact(copyCategoryPersistenceValue(value), [
        "profile",
        "brandReference",
        "productReference",
        "versionReference",
        "operationReference",
        "aggregateSnapshotDigest",
        "originalIntentDigest",
        "absence",
        "eligibility",
        "observedAt",
        "validUntil",
        "digest",
      ]),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogProductVariantCreationAbsenceV1" ||
      r.absence !== "NoRecordedProductOrOperation" ||
      r.eligibility !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const body = Object.freeze({
      profile: "CatalogProductVariantCreationAbsenceV1" as const,
      brandReference: parseCatalogReference(r.brandReference),
      productReference: parseCatalogReference(r.productReference),
      versionReference: parseCatalogReference(r.versionReference),
      operationReference: parseCatalogReference(r.operationReference),
      aggregateSnapshotDigest: parsePublishingDigest(r.aggregateSnapshotDigest),
      originalIntentDigest: parsePublishingDigest(r.originalIntentDigest),
      absence: "NoRecordedProductOrOperation" as const,
      eligibility: "NotEvaluated" as const,
      observedAt,
      validUntil,
    });
    if (r.digest !== hash(body)) return fail();
    return Object.freeze({ ...body, digest: r.digest });
  } catch {
    return fail();
  }
}
export function assertProductVariantCreationAbsence(requestValue: unknown, value: unknown): void {
  const request = parseProductVariantCreationRequest(requestValue),
    proof = parseProductVariantCreationAbsence(value),
    expected = buildProductVariantCreationAbsence(
      {
        productExists: false,
        operationExists: false,
        historyExists: false,
        observedAt: proof.observedAt,
      },
      request,
    );
  if (canonicalizeRfc8785(proof) !== canonicalizeRfc8785(expected)) return fail();
}
