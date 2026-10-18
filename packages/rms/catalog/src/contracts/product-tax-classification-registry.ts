import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  parseCatalogHash,
} from "./product.js";
import {
  parseProductTaxClassificationRegistryStructure,
  assertProductTaxClassificationRegistrySuccessor,
  resolveProductTaxClassification,
} from "../domain/product-tax-classification-registry.js";
export type {
  CatalogProductTaxClassificationRegistry,
  CatalogProductTaxClassificationDefinition,
} from "../domain/product-tax-classification-registry.js";
export const taxClassificationRegistryFields = Object.freeze([
  "registryReference",
  "registryVersion",
  "versionReference",
  "defaultLocale",
  "definitions",
  "defaultClassificationReference",
  "operationHistory",
] as const);
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function record(value: unknown, fields: readonly string[]) {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(r, key))
  )
    return fail();
  return r as Record<string, unknown>;
}
export function parseCatalogProductTaxClassificationRegistry(value: unknown) {
  const registry = parseProductTaxClassificationRegistryStructure(
    copyCategoryPersistenceValue(value),
  );
  if (new TextEncoder().encode(canonicalizeRfc8785(registry)).length > 1048576) return fail();
  return registry;
}
export const catalogProductTaxClassificationRegistryDigest = (value: unknown) =>
  hash(parseCatalogProductTaxClassificationRegistry(value));
export function parseCatalogTaxClassificationRegistryCommand(value: unknown) {
  const r = record(value, [
    "purposeCode",
    "tenantReference",
    "brandReference",
    "actorReference",
    "actorKind",
    "operationReference",
    "expectedRegistryVersion",
    "occurredAt",
    "reasonCode",
    "registry",
  ]);
  const registry = parseCatalogProductTaxClassificationRegistry(r.registry);
  if (
    r.purposeCode !== "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY" ||
    r.actorKind !== "User" ||
    !Number.isSafeInteger(r.expectedRegistryVersion) ||
    (r.expectedRegistryVersion as number) < 0 ||
    (r.expectedRegistryVersion as number) >= 2147483647
  )
    return fail();
  const command = Object.freeze({
    purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY" as const,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
    actorKind: "User" as const,
    operationReference: parseCatalogReference(r.operationReference),
    expectedRegistryVersion: r.expectedRegistryVersion as number,
    occurredAt: parseCatalogInstant(r.occurredAt),
    reasonCode: parseCatalogCode(r.reasonCode),
    registry,
  });
  if (
    registry.tenantReference !== command.tenantReference ||
    registry.brandReference !== command.brandReference ||
    registry.registryVersion !== command.expectedRegistryVersion + 1 ||
    registry.registeredAt !== command.occurredAt
  )
    return fail();
  return Object.freeze({ ...command, intentDigest: hash(command), snapshotDigest: hash(registry) });
}
export type CatalogTaxClassificationRegistryCommand = ReturnType<
  typeof parseCatalogTaxClassificationRegistryCommand
>;
export function catalogTaxClassificationRegistryRequest(
  command: CatalogTaxClassificationRegistryCommand,
) {
  const { intentDigest, snapshotDigest, ...request } = command;
  void intentDigest;
  void snapshotDigest;
  return Object.freeze(request);
}
export function assertCatalogProductTaxClassificationRegistrySuccessor(
  currentValue: unknown,
  nextValue: unknown,
) {
  const current =
      currentValue === null ? null : parseCatalogProductTaxClassificationRegistry(currentValue),
    next = parseCatalogProductTaxClassificationRegistry(nextValue);
  if (next.previousSnapshotDigest !== (current === null ? null : hash(current)))
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  assertProductTaxClassificationRegistrySuccessor(current, next);
}
export function parseCatalogTaxClassificationRegistryObservation(value: unknown) {
  const r = record(value, ["originalIntentDigest", "observedAt", "validUntil"]),
    observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 30000)
    return fail();
  if (typeof r.originalIntentDigest !== "string" || !r.originalIntentDigest.startsWith("sha256:"))
    return fail();
  return Object.freeze({
    originalIntentDigest: "sha256:" + parseCatalogHash(r.originalIntentDigest.slice(7)),
    observedAt,
    validUntil,
  });
}
export type CatalogTaxClassificationRegistryObservation = ReturnType<
  typeof parseCatalogTaxClassificationRegistryObservation
>;
export function parseCatalogProductTaxClassificationResolutionRequest(value: unknown) {
  const r = record(value, [
    "classificationReference",
    "originalIntentDigest",
    "observedAt",
    "validUntil",
  ]);
  return Object.freeze({
    classificationReference:
      r.classificationReference === null ? null : parseCatalogReference(r.classificationReference),
    ...parseCatalogTaxClassificationRegistryObservation({
      originalIntentDigest: r.originalIntentDigest,
      observedAt: r.observedAt,
      validUntil: r.validUntil,
    }),
  });
}
export type CatalogProductTaxClassificationResolutionRequest = ReturnType<
  typeof parseCatalogProductTaxClassificationResolutionRequest
>;
/** Pure binding only. Current owning acquisition and its original lease must
 * surround this computation; a supplied registry cannot certify registration. */
export function resolveCatalogProductTaxClassification(
  registryValue: unknown,
  requestValue: unknown,
) {
  const registry = parseCatalogProductTaxClassificationRegistry(registryValue),
    request = parseCatalogProductTaxClassificationResolutionRequest(requestValue);
  if (registry.registeredAt > request.observedAt)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const body = Object.freeze({
    profile: "CatalogProductTaxClassificationResolutionV1" as const,
    tenantReference: registry.tenantReference,
    brandReference: registry.brandReference,
    registryReference: registry.registryReference,
    registryVersion: registry.registryVersion,
    versionReference: registry.versionReference,
    snapshotDigest: hash(registry),
    request,
    ...resolveProductTaxClassification(registry, request.classificationReference),
    sourceAuthority: "NotEvaluated" as const,
    taxCalculation: "NotEvaluated" as const,
  });
  return Object.freeze({ ...body, digest: hash(body) });
}
export type CatalogProductTaxClassificationResolution = ReturnType<
  typeof resolveCatalogProductTaxClassification
>;
export function catalogTaxClassificationRegistryEventId(
  command: CatalogTaxClassificationRegistryCommand,
) {
  const digest = sha256Hex(
    "CatalogTaxClassificationRegistryEvent:v1:" +
      command.tenantReference +
      ":" +
      command.brandReference +
      ":" +
      command.operationReference,
  );
  return parseCatalogReference(
    command.operationReference.slice(0, 14) +
      "7" +
      digest.slice(0, 3) +
      "-8" +
      digest.slice(3, 6) +
      "-" +
      digest.slice(6, 18),
  );
}
