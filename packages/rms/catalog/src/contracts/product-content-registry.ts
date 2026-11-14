import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  parseProductAggregate,
} from "./product.js";
import {
  parseProductContentRegistryStructure,
  assertProductContentRegistrySuccessor,
  assertProductRegisteredContentReferences,
} from "../domain/product-content-registry.js";
export type {
  CatalogProductContentRegistry,
  CatalogTagDefinition,
  CatalogAttributeDefinition,
} from "../domain/product-content-registry.js";
export const contentRegistryFields = Object.freeze([
  "registryReference",
  "registryVersion",
  "versionReference",
  "defaultLocale",
  "tags",
  "attributes",
  "operationHistory",
] as const);
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function record(value: unknown, keys: readonly string[]) {
  const copied = copyCategoryPersistenceValue(value);
  if (
    !copied ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(copied, k))
  )
    return fail();
  return copied as Record<string, unknown>;
}
export function parseCatalogProductContentRegistry(value: unknown) {
  const registry = parseProductContentRegistryStructure(copyCategoryPersistenceValue(value));
  if (new TextEncoder().encode(canonicalizeRfc8785(registry)).length > 1048576) return fail();
  return registry;
}
export const catalogProductContentRegistryDigest = (value: unknown) =>
  hash(parseCatalogProductContentRegistry(value));
export function parseCatalogContentRegistryCommand(value: unknown) {
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
    ]),
    registry = parseCatalogProductContentRegistry(r.registry);
  if (
    r.purposeCode !== "CATALOG_PRODUCT_CONTENT_REGISTRY" ||
    r.actorKind !== "User" ||
    !Number.isSafeInteger(r.expectedRegistryVersion) ||
    (r.expectedRegistryVersion as number) < 0 ||
    (r.expectedRegistryVersion as number) >= 2147483647
  )
    return fail();
  const command = Object.freeze({
    purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY" as const,
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
export type CatalogContentRegistryCommand = ReturnType<typeof parseCatalogContentRegistryCommand>;
export function assertCatalogProductContentRegistrySuccessor(
  currentValue: unknown,
  nextValue: unknown,
) {
  const current = currentValue === null ? null : parseCatalogProductContentRegistry(currentValue),
    next = parseCatalogProductContentRegistry(nextValue);
  if (next.previousSnapshotDigest !== (current === null ? null : hash(current)))
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  assertProductContentRegistrySuccessor(current, next);
}
/** Actual source acquisition must surround this rule, through the writer's COMMIT. */
export function validateCatalogProductRegisteredContent(
  aggregateValue: unknown,
  registryValue: unknown,
) {
  const aggregate = parseProductAggregate(copyCategoryPersistenceValue(aggregateValue)),
    registry = parseCatalogProductContentRegistry(registryValue);
  assertProductRegisteredContentReferences(aggregate, registry);
  return Object.freeze({
    profile: "CatalogRegisteredProductContentAssessmentV1" as const,
    registryReference: registry.registryReference,
    registryVersion: registry.registryVersion,
    versionReference: registry.versionReference,
    snapshotDigest: hash(registry),
    checks: Object.freeze(["TagRegistry", "AttributeRegistry"] as const),
    referenceEligibility: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  });
}
export function parseCatalogContentRegistryObservation(value: unknown) {
  const r = record(value, ["originalIntentDigest", "observedAt", "validUntil"]);
  if (
    typeof r.originalIntentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(r.originalIntentDigest)
  )
    return fail();
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 30000)
    return fail();
  return Object.freeze({ originalIntentDigest: r.originalIntentDigest, observedAt, validUntil });
}
export type CatalogContentRegistryObservation = ReturnType<
  typeof parseCatalogContentRegistryObservation
>;
/** Parsed request representation stored for exact original operation recovery. */
export function catalogContentRegistryRequest(command: CatalogContentRegistryCommand) {
  const { intentDigest, snapshotDigest, ...request } = command;
  void intentDigest;
  void snapshotDigest;
  return Object.freeze(request);
}
export function catalogContentRegistryEventId(command: CatalogContentRegistryCommand) {
  const digest = sha256Hex(
    "CatalogContentRegistryEvent:v1:" +
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
