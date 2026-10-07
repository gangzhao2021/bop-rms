import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";

const scopeFields = ["tenantReference", "brandReference", "actorReference"] as const;
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const copied = copyCategoryPersistenceValue(value);
  if (
    !copied ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Reflect.ownKeys(copied).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(copied, field))
  )
    return fail();
  return copied as Record<string, unknown>;
}
function scope(r: Record<string, unknown>) {
  return Object.freeze({
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
  });
}
export function parseBrandCatalogSourceScope(value: unknown) {
  return scope(exact(value, scopeFields));
}
export type BrandCatalogSourceScope = ReturnType<typeof parseBrandCatalogSourceScope>;
function label(value: unknown): string {
  if (typeof value !== "string") return fail();
  for (const character of value) {
    const point = character.charCodeAt(0);
    if (point <= 31 || (point >= 127 && point <= 159)) return fail();
  }
  const result = value.trim();
  if (!result.length || result.length > 200) return fail();
  return result;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}

/** Registers the existing Brand catalogue namespace, not a Product or a publication. */
export function parseBrandCatalogSourceRegister(value: unknown) {
  const r = exact(value, ["profile", ...scopeFields, "operationReference", "code", "label"]);
  if (r.profile !== "BrandCatalogSourceRegisterV1") return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceRegisterV1" as const,
    ...scope(r),
    operationReference: parseCatalogReference(r.operationReference),
    code: parseCatalogCode(r.code),
    label: label(r.label),
  });
}
export type BrandCatalogSourceRegister = ReturnType<typeof parseBrandCatalogSourceRegister>;
export function brandCatalogSourceIntentDigest(value: unknown) {
  return digest("sha256:" + sha256Hex(canonicalizeRfc8785(parseBrandCatalogSourceRegister(value))));
}
export function parseBrandCatalogSourceResolve(value: unknown) {
  const r = exact(value, ["profile", ...scopeFields, "operationReference", "intentDigest"]);
  if (r.profile !== "BrandCatalogSourceResolveV1") return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceResolveV1" as const,
    ...scope(r),
    operationReference: parseCatalogReference(r.operationReference),
    intentDigest: digest(r.intentDigest),
  });
}
export type BrandCatalogSourceResolve = ReturnType<typeof parseBrandCatalogSourceResolve>;

export function parseBrandCatalogSourceRegisteredIdentity(value: unknown) {
  const r = exact(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "sourceReference",
    "code",
    "label",
    "registeredByReference",
    "operationReference",
    "auditReference",
    "registeredAt",
    "dataClassification",
  ]);
  if (
    r.profile !== "BrandCatalogSourceRegisteredIdentityV1" ||
    r.dataClassification !== "ConfigurationMetadata"
  )
    return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceRegisteredIdentityV1" as const,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    sourceReference: parseCatalogReference(r.sourceReference),
    code: parseCatalogCode(r.code),
    label: label(r.label),
    registeredByReference: parseCatalogReference(r.registeredByReference),
    operationReference: parseCatalogReference(r.operationReference),
    auditReference: parseCatalogReference(r.auditReference),
    registeredAt: parseCatalogInstant(r.registeredAt),
    dataClassification: "ConfigurationMetadata" as const,
  });
}
export type BrandCatalogSourceRegisteredIdentity = ReturnType<
  typeof parseBrandCatalogSourceRegisteredIdentity
>;
const currentFields = [
  "profile",
  ...scopeFields,
  "source",
  "observedAt",
  "validUntil",
  "publicationStatus",
  "referenceEligibility",
] as const;
function current(r: Record<string, unknown>, reader: unknown, now: string) {
  const actualScope = scope(r),
    expectedScope = parseBrandCatalogSourceScope(reader),
    observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil),
    at = parseCatalogInstant(now),
    source = r.source === null ? null : parseBrandCatalogSourceRegisteredIdentity(r.source);
  if (
    canonicalizeRfc8785(actualScope) !== canonicalizeRfc8785(expectedScope) ||
    r.publicationStatus !== "NotEvaluated" ||
    r.referenceEligibility !== "NotEvaluated" ||
    observedAt > at ||
    at >= validUntil ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    (source !== null &&
      (source.tenantReference !== actualScope.tenantReference ||
        source.brandReference !== actualScope.brandReference ||
        source.registeredAt > observedAt))
  )
    return fail();
  return Object.freeze({
    ...actualScope,
    source,
    observedAt,
    validUntil,
    publicationStatus: "NotEvaluated" as const,
    referenceEligibility: "NotEvaluated" as const,
  });
}
/** Current Reader authority must be supplied by the actual owner admission. Historical Actor stays historical. */
export function parseBrandCatalogSourceCurrent(
  value: unknown,
  reader: BrandCatalogSourceScope,
  now: string,
) {
  const r = exact(value, currentFields);
  if (r.profile !== "BrandCatalogSourceCurrentV1") return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceCurrentV1" as const,
    ...current(r, reader, now),
  });
}
export type BrandCatalogSourceCurrent = ReturnType<typeof parseBrandCatalogSourceCurrent>;
export function parseBrandCatalogSourceExact(
  value: unknown,
  reader: BrandCatalogSourceScope,
  requested: string,
  now: string,
) {
  const r = exact(value, [...currentFields, "requestedSourceReference"]),
    requestedSourceReference = parseCatalogReference(r.requestedSourceReference),
    expected = parseCatalogReference(requested);
  if (r.profile !== "BrandCatalogSourceExactV1" || requestedSourceReference !== expected)
    return fail();
  const result = current(r, reader, now);
  if (result.source !== null && result.source.sourceReference !== requestedSourceReference)
    return fail();
  return Object.freeze({
    profile: "BrandCatalogSourceExactV1" as const,
    ...result,
    requestedSourceReference,
  });
}
export type BrandCatalogSourceExact = ReturnType<typeof parseBrandCatalogSourceExact>;

/** Abandoned retains the known scalar intent only; it cannot reconstruct an unknown command body. */
export function parseBrandCatalogSourceReceipt(value: unknown) {
  const r = exact(value, [
    "profile",
    ...scopeFields,
    "operationReference",
    "intentDigest",
    "outcome",
    "originalCommand",
    "source",
    "auditReference",
    "occurredAt",
  ]);
  if (r.profile !== "BrandCatalogSourceReceiptV1") return fail();
  const receiptScope = scope(r),
    operationReference = parseCatalogReference(r.operationReference),
    intentDigest = digest(r.intentDigest),
    auditReference = parseCatalogReference(r.auditReference),
    occurredAt = parseCatalogInstant(r.occurredAt),
    body = {
      profile: "BrandCatalogSourceReceiptV1" as const,
      ...receiptScope,
      operationReference,
      intentDigest,
      auditReference,
      occurredAt,
    };
  if (r.outcome === "Abandoned") {
    if (r.originalCommand !== null || r.source !== null) return fail();
    return Object.freeze({
      ...body,
      outcome: "Abandoned" as const,
      originalCommand: null,
      source: null,
    });
  }
  if (r.outcome !== "Committed") return fail();
  const originalCommand = parseBrandCatalogSourceRegister(r.originalCommand),
    source = parseBrandCatalogSourceRegisteredIdentity(r.source);
  if (
    originalCommand.tenantReference !== receiptScope.tenantReference ||
    originalCommand.brandReference !== receiptScope.brandReference ||
    originalCommand.actorReference !== receiptScope.actorReference ||
    originalCommand.operationReference !== operationReference ||
    brandCatalogSourceIntentDigest(originalCommand) !== intentDigest ||
    source.tenantReference !== receiptScope.tenantReference ||
    source.brandReference !== receiptScope.brandReference ||
    source.registeredByReference !== receiptScope.actorReference ||
    source.operationReference !== operationReference ||
    source.code !== originalCommand.code ||
    source.label !== originalCommand.label ||
    source.auditReference !== auditReference ||
    source.registeredAt !== occurredAt
  )
    return fail();
  return Object.freeze({ ...body, outcome: "Committed" as const, originalCommand, source });
}
export type BrandCatalogSourceReceipt = ReturnType<typeof parseBrandCatalogSourceReceipt>;
