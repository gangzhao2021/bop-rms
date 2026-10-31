import { expect, it, vi } from "vitest";
import {
  parseCatalogProductTaxClassificationRegistry,
  catalogProductTaxClassificationRegistryDigest,
  assertCatalogProductTaxClassificationRegistrySuccessor,
  parseCatalogTaxClassificationRegistryCommand,
  parseCatalogTaxClassificationRegistryObservation,
  parseCatalogProductTaxClassificationResolutionRequest,
  resolveCatalogProductTaxClassification,
  catalogTaxClassificationRegistryRequest,
  catalogTaxClassificationRegistryEventId,
} from "../contracts/product-tax-classification-registry.js";
import { parseCatalogProductContentRegistry } from "../contracts/product-content-registry.js";
const id = (n: number) => "01902433-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-02T10:00:00.000Z",
  until = "2026-10-02T10:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture definition");
  return value;
}
function fixture() {
  return {
    profile: "CatalogProductTaxClassificationRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(3),
    versionReference: id(4),
    registryVersion: 1,
    defaultLocale: "en-CA",
    previousSnapshotDigest: null as string | null,
    registeredAt: at,
    defaultClassificationReference: null as string | null,
    definitions: [
      {
        classificationReference: id(10),
        code: "SYNTHETIC_ACTIVE",
        localizedNames: { "en-CA": "Synthetic classification" },
        lifecycle: "Active",
      },
      {
        classificationReference: id(11),
        code: "SYNTHETIC_INACTIVE",
        localizedNames: { "en-CA": "Synthetic inactive" },
        lifecycle: "Inactive",
      },
      {
        classificationReference: id(12),
        code: "SYNTHETIC_RETIRED",
        localizedNames: { "en-CA": "Synthetic retired" },
        lifecycle: "Retired",
      },
    ],
  };
}
const command = (registry = fixture()) => ({
  purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(5),
  actorKind: "User",
  operationReference: id(6),
  expectedRegistryVersion: registry.registryVersion - 1,
  occurredAt: registry.registeredAt,
  reasonCode: "SYNTHETIC",
  registry,
});
const request = (classificationReference: string | null = id(10)) => ({
  classificationReference,
  originalIntentDigest: digest,
  observedAt: at,
  validUntil: until,
});
function next() {
  const before = fixture();
  return {
    ...before,
    versionReference: id(40),
    registryVersion: 2,
    previousSnapshotDigest: catalogProductTaxClassificationRegistryDigest(before),
  };
}

it("parses detached immutable identity metadata and canonical set order without tax treatment", () => {
  const input = fixture(),
    parsed = parseCatalogProductTaxClassificationRegistry(input);
  input.definitions.reverse();
  expect(catalogProductTaxClassificationRegistryDigest(input)).toBe(
    catalogProductTaxClassificationRegistryDigest(parsed),
  );
  present(input.definitions[0]).localizedNames["en-CA"] = "Changed caller";
  expect(parsed.definitions[2]?.localizedNames["en-CA"]).toBe("Synthetic retired");
  expect(Object.isFrozen(parsed.definitions[0]?.localizedNames)).toBe(true);
  expect(Object.isFrozen(parsed.definitions)).toBe(true);
  expect(Object.hasOwn(parsed, "rate")).toBe(false);
  expect(() => parseCatalogProductContentRegistry(parsed)).toThrow();
});
it.each([
  [id(10), "Resolved", "Pass"],
  [id(11), "Inactive", "HardError"],
  [id(12), "Retired", "HardError"],
  [id(99), "Unknown", "HardError"],
] as const)(
  "resolves explicit identity %s from the complete registry",
  (reference, reason, outcome) => {
    const value = resolveCatalogProductTaxClassification(fixture(), request(reference));
    expect(value).toMatchObject({
      selection: "Explicit",
      classificationReference: reference,
      reason,
      check: { code: "TaxResolution", outcome },
      sourceAuthority: "NotEvaluated",
      taxCalculation: "NotEvaluated",
      request: request(reference),
    });
  },
);
it("requires an explicit default mapping even with exactly one active definition", () => {
  expect(resolveCatalogProductTaxClassification(fixture(), request(null))).toMatchObject({
    selection: "BrandDefault",
    classificationReference: null,
    reason: "DefaultMissing",
    check: { outcome: "HardError" },
  });
  const registry = { ...fixture(), defaultClassificationReference: id(10) };
  expect(resolveCatalogProductTaxClassification(registry, request(null))).toMatchObject({
    selection: "BrandDefault",
    classificationReference: id(10),
    reason: "Resolved",
    check: { outcome: "Pass" },
    snapshotDigest: catalogProductTaxClassificationRegistryDigest(registry),
  });
  expect(resolveCatalogProductTaxClassification(registry, request(id(11)))).toMatchObject({
    selection: "Explicit",
    reason: "Inactive",
    check: { outcome: "HardError" },
  });
});
it.each([id(11), id(12), id(999)])(
  "refuses unavailable defaults %s at registration",
  (reference) => {
    expect(() =>
      parseCatalogProductTaxClassificationRegistry({
        ...fixture(),
        defaultClassificationReference: reference,
      }),
    ).toThrow();
  },
);
it("retains all historical IDs/codes and permits explicit deactivation/default clearing", () => {
  const before = { ...fixture(), defaultClassificationReference: id(10) };
  const after = {
    ...next(),
    previousSnapshotDigest: catalogProductTaxClassificationRegistryDigest(before),
  };
  present(after.definitions[0]).lifecycle = "Inactive";
  expect(() => assertCatalogProductTaxClassificationRegistrySuccessor(before, after)).not.toThrow();
  expect(resolveCatalogProductTaxClassification(after, request(id(10))).reason).toBe("Inactive");
});
it.each(["delete", "code", "revive", "registry", "scope", "version", "digest", "time"])(
  "rejects permanent history mutation: %s",
  (change) => {
    const before = fixture(),
      after = next();
    if (change === "delete") after.definitions.pop();
    if (change === "code") present(after.definitions[0]).code = "OTHER";
    if (change === "revive") present(after.definitions[2]).lifecycle = "Active";
    if (change === "registry") after.registryReference = id(99);
    if (change === "scope") after.brandReference = id(99);
    if (change === "version") after.versionReference = before.versionReference;
    if (change === "digest") after.previousSnapshotDigest = digest;
    if (change === "time") after.registeredAt = "2026-10-01T10:00:00.000Z";
    expect(() => assertCatalogProductTaxClassificationRegistrySuccessor(before, after)).toThrow();
  },
);
it.each([
  "rate",
  "duplicateId",
  "duplicateCode",
  "defaultName",
  "unknownLifecycle",
  "missingDefault",
  "oversize",
  "prototype",
  "accessor",
])("rejects malformed registry input: %s", (change) => {
  const input = fixture(),
    getter = vi.fn(() => "Forbidden");
  if (change === "rate") Object.assign(present(input.definitions[0]), { rate: "0.13" });
  if (change === "duplicateId") present(input.definitions[1]).classificationReference = id(10);
  if (change === "duplicateCode") present(input.definitions[1]).code = "SYNTHETIC_ACTIVE";
  if (change === "defaultName") input.defaultLocale = "fr-CA";
  if (change === "unknownLifecycle") present(input.definitions[0]).lifecycle = "Published";
  if (change === "missingDefault") Reflect.deleteProperty(input, "defaultClassificationReference");
  if (change === "oversize")
    input.definitions = Array.from({ length: 1001 }, () => present(fixture().definitions[0]));
  if (change === "prototype") Object.setPrototypeOf(input, { inherited: true });
  if (change === "accessor")
    Object.defineProperty(input.definitions[0], "code", { get: getter, enumerable: true });
  expect(() => parseCatalogProductTaxClassificationRegistry(input)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("binds a User command and immutable original intent without accepting supplied checks", () => {
  const value = parseCatalogTaxClassificationRegistryCommand(command());
  expect(catalogTaxClassificationRegistryRequest(value)).toEqual(command());
  expect(value.snapshotDigest).toBe(catalogProductTaxClassificationRegistryDigest(value.registry));
  expect(catalogTaxClassificationRegistryEventId(value)).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{3}-8/);
  for (const patch of [
    { actorKind: "System" },
    { expectedRegistryVersion: 1 },
    { tenantReference: id(99) },
    { purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY" },
    { assertedRegistered: true },
    { occurredAt: until },
  ])
    expect(() =>
      parseCatalogTaxClassificationRegistryCommand({ ...command(), ...patch }),
    ).toThrow();
});
it("preserves the caller's original exclusive lease and rejects renewal or future registry data", () => {
  const observed = parseCatalogTaxClassificationRegistryObservation({
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: until,
  });
  expect(observed.validUntil).toBe(until);
  expect(
    parseCatalogProductTaxClassificationResolutionRequest(request()).originalIntentDigest,
  ).toBe(digest);
  for (const originalIntentDigest of [
    "a".repeat(64),
    "SHA256:" + "a".repeat(64),
    "sha256:" + "a".repeat(63),
    "sha256:" + "g".repeat(64),
  ])
    expect(() =>
      parseCatalogProductTaxClassificationResolutionRequest({
        ...request(),
        originalIntentDigest,
      }),
    ).toThrow();
  for (const end of [at, "2026-10-02T10:00:30.001Z"])
    expect(() =>
      parseCatalogProductTaxClassificationResolutionRequest({ ...request(), validUntil: end }),
    ).toThrow();
  expect(() =>
    resolveCatalogProductTaxClassification({ ...fixture(), registeredAt: until }, request()),
  ).toThrow();
  expect(() =>
    parseCatalogProductTaxClassificationResolutionRequest({
      ...request(),
      assertedRegistered: true,
    }),
  ).toThrow();
});
