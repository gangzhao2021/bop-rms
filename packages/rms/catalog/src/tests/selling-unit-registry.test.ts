import { expect, it, vi } from "vitest";
import {
  parseCatalogSellingUnitRegistry,
  catalogSellingUnitRegistryDigest,
  parseCatalogSellingUnitRegistryCommand,
  assertCatalogSellingUnitRegistrySuccessor,
  assertCatalogRegisteredSellingUnitQuantity,
  catalogSellingUnitDefinitionsDigest,
  assertCatalogSellingUnitRegistryBootstrap,
  buildCatalogSellingUnitRegistrationResolution,
  parseCatalogSellingUnitRegistrationResolution,
  parseCatalogSellingUnitRegistrationResolutionCommand,
} from "../contracts/selling-unit-registry.js";
const id = (n: number) => "01902433-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-04T10:00:00.000Z";
function fixture() {
  return {
    profile: "CatalogSellingUnitRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(3),
    versionReference: id(4),
    registryVersion: 1,
    previousSnapshotDigest: null as string | null,
    registeredAt: at,
    defaultLocale: "en-CA",
    units: [
      {
        unitReference: id(10),
        code: "SYNTHETIC_UNIT",
        semanticDefinition: "Synthetic registered selling unit",
        quantityDecimalPlaces: 2,
        localizedNames: { "en-CA": "Synthetic unit" },
        lifecycle: "Active",
      },
      {
        unitReference: id(11),
        code: "SYNTHETIC_RETIRED",
        semanticDefinition: "Synthetic retired unit",
        quantityDecimalPlaces: 0,
        localizedNames: { "en-CA": "Retired unit" },
        lifecycle: "Retired",
      },
    ],
  };
}
function first<T>(value: readonly T[]): T {
  const item = value[0];
  if (item === undefined) throw new Error("Missing fixture");
  return item;
}
function next() {
  const previous = fixture();
  return {
    ...previous,
    versionReference: id(20),
    registryVersion: 2,
    previousSnapshotDigest: catalogSellingUnitRegistryDigest(previous),
  };
}
function command() {
  return {
    purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(5),
    actorKind: "User",
    operationReference: id(6),
    expectedRegistryVersion: 0,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
    registry: fixture(),
  };
}
it("detaches immutable registration metadata and normalizes set ordering", () => {
  const input = fixture(),
    parsed = parseCatalogSellingUnitRegistry(input);
  input.units.reverse();
  expect(catalogSellingUnitRegistryDigest(input)).toBe(catalogSellingUnitRegistryDigest(parsed));
  first(input.units).localizedNames["en-CA"] = "Changed";
  expect(parsed.units[1]?.localizedNames["en-CA"]).toBe("Retired unit");
  expect(Object.isFrozen(parsed.units)).toBe(true);
  expect(Object.isFrozen(parsed.units[0]?.localizedNames)).toBe(true);
});
it.each([
  "unknown",
  "prototype",
  "accessor",
  "duplicateCode",
  "duplicateId",
  "precision",
  "missingLocale",
  "markup",
  "oversize",
])("refuses malformed registration %s", (kind) => {
  const r = fixture(),
    getter = vi.fn(() => "Hidden");
  if (kind === "unknown") Object.assign(r, { registered: true });
  if (kind === "prototype") Object.setPrototypeOf(r, { inherited: true });
  if (kind === "accessor")
    Object.defineProperty(first(r.units), "code", { get: getter, enumerable: true });
  if (kind === "duplicateCode") first(r.units).code = "SYNTHETIC_RETIRED";
  if (kind === "duplicateId") first(r.units).unitReference = id(11);
  if (kind === "precision") first(r.units).quantityDecimalPlaces = 7;
  if (kind === "missingLocale") r.defaultLocale = "fr-CA";
  if (kind === "markup") first(r.units).semanticDefinition = "<hidden>";
  if (kind === "oversize") r.units = Array.from({ length: 1001 }, () => first(fixture().units));
  expect(() => parseCatalogSellingUnitRegistry(r)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("binds original command identity and digests", () => {
  const c = parseCatalogSellingUnitRegistryCommand(command());
  expect(c.snapshotDigest).toBe(catalogSellingUnitRegistryDigest(c.registry));
  expect(c.intentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  for (const patch of [
    { actorKind: "System" },
    { brandReference: id(99) },
    { expectedRegistryVersion: 1 },
    { occurredAt: "2026-10-04T10:00:01.000Z" },
    { purposeCode: "OTHER" },
    { registered: true },
  ])
    expect(() => parseCatalogSellingUnitRegistryCommand({ ...command(), ...patch })).toThrow();
});
it("does not execute command accessors and normalizes closed-command errors", () => {
  const getter = vi.fn(() => "Hidden"),
    c = command();
  Object.defineProperty(c, "actorKind", { get: getter, enumerable: true });
  expect(() => parseCatalogSellingUnitRegistryCommand(c)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parseCatalogSellingUnitRegistryCommand({ ...command(), unapproved: true }),
  ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
});
it("requires actual empty history for initial registration, never an unavailable default", () => {
  expect(() => assertCatalogSellingUnitRegistrySuccessor(null, fixture(), [])).not.toThrow();
  expect(() =>
    assertCatalogSellingUnitRegistrySuccessor(null, fixture(), ["SYNTHETIC_UNIT"]),
  ).toThrow();
  expect(() =>
    assertCatalogSellingUnitRegistrySuccessor(null, fixture(), undefined as unknown as string[]),
  ).toThrow();
});
it("permits versioned display and lifecycle changes with original semantics retained", () => {
  const n = next();
  first(n.units).localizedNames["en-CA"] = "Updated display";
  first(n.units).lifecycle = "Inactive";
  expect(() =>
    assertCatalogSellingUnitRegistrySuccessor(fixture(), n, ["SYNTHETIC_UNIT"]),
  ).not.toThrow();
});
it.each([
  "delete",
  "code",
  "meaning",
  "precision",
  "revive",
  "digest",
  "brand",
  "registry",
  "version",
  "time",
  "unregisteredHistory",
])("preserves immutable historical unit facts: %s", (kind) => {
  const n = next();
  let assigned = ["SYNTHETIC_UNIT"];
  if (kind === "delete") n.units.shift();
  if (kind === "code") first(n.units).code = "OTHER";
  if (kind === "meaning") first(n.units).semanticDefinition = "Other meaning";
  if (kind === "precision") first(n.units).quantityDecimalPlaces = 3;
  if (kind === "revive") {
    n.units.reverse();
    first(n.units).lifecycle = "Active";
  }
  if (kind === "digest") n.previousSnapshotDigest = "sha256:" + "a".repeat(64);
  if (kind === "brand") n.brandReference = id(99);
  if (kind === "registry") n.registryReference = id(99);
  if (kind === "version") n.versionReference = id(4);
  if (kind === "time") n.registeredAt = "2026-10-03T10:00:00.000Z";
  if (kind === "unregisteredHistory") assigned = ["OTHER"];
  expect(() => assertCatalogSellingUnitRegistrySuccessor(fixture(), n, assigned)).toThrow();
});
it.each(["1", "0.01", "1.20", "1.000000", "99999999999999.99"])(
  "accepts positive registered quantity %s without float arithmetic",
  (quantity) => {
    expect(() =>
      assertCatalogRegisteredSellingUnitQuantity(fixture(), id(2), "SYNTHETIC_UNIT", quantity),
    ).not.toThrow();
  },
);
it.each(["0", "0.000000", "-1", "0.001", "100000000000000", "1e2", 1, null])(
  "refuses zero, invalid or unrepresentable quantity %s",
  (quantity) => {
    expect(() =>
      assertCatalogRegisteredSellingUnitQuantity(fixture(), id(2), "SYNTHETIC_UNIT", quantity),
    ).toThrow();
  },
);
it("requires actual active unit identity and exact owning Brand", () => {
  for (const code of ["UNKNOWN", "SYNTHETIC_RETIRED"])
    expect(() => assertCatalogRegisteredSellingUnitQuantity(fixture(), id(2), code, "1")).toThrow();
  expect(() =>
    assertCatalogRegisteredSellingUnitQuantity(fixture(), id(99), "SYNTHETIC_UNIT", "1"),
  ).toThrow();
  const r = fixture();
  first(r.units).lifecycle = "Inactive";
  expect(() =>
    assertCatalogRegisteredSellingUnitQuantity(r, id(2), "SYNTHETIC_UNIT", "1"),
  ).toThrow();
});

function confirmation(registry = fixture()) {
  return {
    profile: "CatalogSellingUnitBootstrapConfirmationV1",
    historyDigest: "sha256:" + "a".repeat(64),
    definitionsDigest: catalogSellingUnitDefinitionsDigest(registry),
    confirmations: [
      {
        unitCode: "SYNTHETIC_UNIT",
        semanticDefinition: first(registry.units).semanticDefinition,
        confirmed: true,
      },
    ],
  };
}
it("initial confirmation is immutable original command/audit metadata and changes intent digest", () => {
  const input = { ...command(), bootstrapConfirmation: confirmation() },
    parsed = parseCatalogSellingUnitRegistryCommand(input);
  expect(parsed.bootstrapConfirmation).toMatchObject(input.bootstrapConfirmation);
  expect(parsed.intentDigest).not.toBe(
    parseCatalogSellingUnitRegistryCommand(command()).intentDigest,
  );
  first(input.bootstrapConfirmation.confirmations).semanticDefinition = "Changed";
  expect(parsed.bootstrapConfirmation?.confirmations[0]?.semanticDefinition).toBe(
    "Synthetic registered selling unit",
  );
});
it.each(["null", "false", "missingCode", "duplicate", "wrongMeaning", "wrongDefinitions", "extra"])(
  "never infers bootstrap consent: %s",
  (kind) => {
    const c = confirmation();
    let value: unknown = c;
    if (kind === "null") value = null;
    if (kind === "false") Object.assign(first(c.confirmations), { confirmed: false });
    if (kind === "missingCode") c.confirmations = [];
    if (kind === "duplicate") c.confirmations.push({ ...first(c.confirmations) });
    if (kind === "wrongMeaning") first(c.confirmations).semanticDefinition = "Different meaning";
    if (kind === "wrongDefinitions") c.definitionsDigest = "sha256:" + "b".repeat(64);
    if (kind === "extra") Object.assign(c, { actorReference: id(999) });
    expect(() =>
      parseCatalogSellingUnitRegistryCommand({ ...command(), bootstrapConfirmation: value }),
    ).toThrow();
  },
);
it("bootstraps exact explicit code mapping without changing known successor rules", () => {
  assertCatalogSellingUnitRegistryBootstrap(
    fixture(),
    [{ unitCode: "SYNTHETIC_UNIT", unitQuantity: "1.25" }],
    confirmation(),
    confirmation().historyDigest,
  );
  expect(() =>
    assertCatalogSellingUnitRegistrySuccessor(null, fixture(), ["SYNTHETIC_UNIT"]),
  ).toThrow();
  expect(() =>
    assertCatalogSellingUnitRegistryBootstrap(
      fixture(),
      [{ unitCode: "SYNTHETIC_UNIT", unitQuantity: "1.234" }],
      confirmation(),
      confirmation().historyDigest,
    ),
  ).toThrow();
  expect(() =>
    assertCatalogSellingUnitRegistryBootstrap(
      fixture(),
      [{ unitCode: "SYNTHETIC_UNIT", unitQuantity: "1.25" }],
      confirmation(),
      "sha256:" + "c".repeat(64),
    ),
  ).toThrow();
});

it("unit registration resolution profiles never accept Product authoring identity", () => {
  const command = {
    profile: "CatalogSellingUnitRegistrationResolutionCommandV1",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(5),
    action: "Create",
    operationReference: id(6),
    expectedRegistryVersion: 0,
  };
  const resolution = buildCatalogSellingUnitRegistrationResolution({
    outcome: "Abandoned",
    command: parseCatalogSellingUnitRegistrationResolutionCommand(command),
    registryReference: null,
    versionReference: null,
    registryVersion: null,
    originalIntentDigest: null,
    snapshotDigest: null,
    recordedAt: at,
  });
  expect(Object.isFrozen(resolution.command)).toBe(true);
  expect(() =>
    parseCatalogSellingUnitRegistrationResolution({ ...resolution, registryVersion: 1 }),
  ).toThrow();
  expect(() =>
    parseCatalogSellingUnitRegistrationResolutionCommand({
      ...command,
      profile: "CatalogProductAuthoringResolutionCommandV1",
    }),
  ).toThrow();
  expect(() =>
    parseCatalogSellingUnitRegistrationResolutionCommand({ ...command, productReference: id(99) }),
  ).toThrow();
});
