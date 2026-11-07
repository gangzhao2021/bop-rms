import { expect, it, vi } from "vitest";
import {
  parseCatalogProductContentRegistry,
  catalogProductContentRegistryDigest,
  assertCatalogProductContentRegistrySuccessor,
  validateCatalogProductRegisteredContent,
  parseCatalogContentRegistryCommand,
  parseCatalogContentRegistryObservation,
  catalogContentRegistryRequest,
} from "../contracts/product-content-registry.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-30T06:30:00.000Z";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture member");
  return value;
}
function fixture() {
  return {
    profile: "CatalogProductContentRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(3),
    versionReference: id(4),
    registryVersion: 1,
    defaultLocale: "en-CA",
    previousSnapshotDigest: null as string | null,
    registeredAt: at,
    tags: [
      {
        tagReference: id(10),
        code: "HOT",
        localizedNames: { "en-CA": "Synthetic tag" },
        lifecycle: "Active",
      },
    ],
    attributes: [
      {
        attributeReference: id(20),
        code: "WEIGHT",
        localizedNames: { "en-CA": "Synthetic decimal" },
        lifecycle: "Active",
        type: "Decimal",
        unitCode: "KG",
        minimumValue: "-0.5",
        maximumValue: "99999999999999.999999",
      },
      {
        attributeReference: id(21),
        code: "LABEL",
        localizedNames: { "en-CA": "Synthetic text" },
        lifecycle: "Active",
        type: "Text",
        maximumLength: 5,
      },
      {
        attributeReference: id(22),
        code: "FLAG",
        localizedNames: { "en-CA": "Synthetic boolean" },
        lifecycle: "Active",
        type: "Boolean",
      },
      {
        attributeReference: id(23),
        code: "ENUM",
        localizedNames: { "en-CA": "Synthetic enum" },
        lifecycle: "Active",
        type: "Enum",
        values: [
          {
            valueReference: id(30),
            code: "ONE",
            localizedNames: { "en-CA": "Synthetic value" },
            lifecycle: "Active",
          },
        ],
      },
    ],
  };
}
const command = (registry = fixture()) => ({
  purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(5),
  actorKind: "User",
  operationReference: id(6),
  expectedRegistryVersion: registry.registryVersion - 1,
  occurredAt: at,
  reasonCode: "SYNTHETIC",
  registry,
});
function candidate(values: unknown[] = []) {
  return {
    productReference: id(100),
    brandReference: id(2),
    internalCode: "REGISTRY",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(5),
    updatedAt: at,
    draft: {
      versionReference: id(101),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [id(10)],
        attributeValues: values,
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  };
}
it("registers all four attribute types as a detached complete definition set", () => {
  const f = fixture(),
    r = parseCatalogProductContentRegistry(f);
  expect(Object.isFrozen(r.attributes)).toBe(true);
  expect(r.attributes).toHaveLength(4);
  expect(catalogProductContentRegistryDigest(r)).toMatch(/^sha256:[a-f0-9]{64}$/);
  required(f.tags[0]).code = "CHANGED";
  expect(r.tags[0]?.code).toBe("HOT");
});
it("canonicalizes set order and exact decimal values without binary-float rounding", () => {
  const f = fixture(),
    changed = { ...f, attributes: [...f.attributes].reverse() };
  expect(catalogProductContentRegistryDigest(f)).toBe(catalogProductContentRegistryDigest(changed));
  const g = {
    ...f,
    attributes: [
      {
        attributeReference: id(20),
        code: "WEIGHT",
        localizedNames: { "en-CA": "Synthetic" },
        lifecycle: "Active",
        type: "Decimal",
        unitCode: "KG",
        minimumValue: "-0.500000",
        maximumValue: "-0.000001",
      },
    ],
  };
  expect(parseCatalogProductContentRegistry(g).attributes[0]).toMatchObject({
    minimumValue: "-0.5",
    maximumValue: "-0.000001",
  });
});
it.each(["code", "type", "unitCode", "attributeReference"])(
  "never reinterprets an existing attribute %s",
  (field) => {
    const f = fixture(),
      next = {
        ...f,
        versionReference: id(7),
        registryVersion: 2,
        previousSnapshotDigest: catalogProductContentRegistryDigest(f),
        attributes: f.attributes.map((a) =>
          a.attributeReference === id(20)
            ? {
                ...a,
                [field]:
                  field === "attributeReference"
                    ? id(99)
                    : field === "code"
                      ? "OTHER"
                      : field === "type"
                        ? "Text"
                        : "G",
              }
            : a,
        ),
      };
    expect(() => assertCatalogProductContentRegistrySuccessor(f, next)).toThrow();
  },
);
it("keeps retired definitions and enum members rather than deleting or reactivating them", () => {
  const f = fixture();
  required(f.tags[0]).lifecycle = "Retired";
  const next = {
    ...f,
    versionReference: id(7),
    registryVersion: 2,
    previousSnapshotDigest: catalogProductContentRegistryDigest(f),
    tags: [{ ...required(f.tags[0]), lifecycle: "Active" }],
  };
  expect(() => assertCatalogProductContentRegistrySuccessor(f, next)).toThrow();
  expect(() => assertCatalogProductContentRegistrySuccessor(f, { ...next, tags: [] })).toThrow();
  const original = fixture(),
    missing = {
      ...original,
      versionReference: id(7),
      registryVersion: 2,
      previousSnapshotDigest: catalogProductContentRegistryDigest(original),
      attributes: original.attributes.filter((a) => a.attributeReference !== id(23)),
    };
  expect(() => assertCatalogProductContentRegistrySuccessor(original, missing)).toThrow();
});
it("allows new definitions and changed current bounds while preserving snapshot identity", () => {
  const f = fixture(),
    next = {
      ...f,
      versionReference: id(7),
      registryVersion: 2,
      previousSnapshotDigest: catalogProductContentRegistryDigest(f),
      tags: [
        ...f.tags,
        {
          tagReference: id(11),
          code: "COLD",
          localizedNames: { "en-CA": "Synthetic" },
          lifecycle: "Active",
        },
      ],
      attributes: f.attributes.map((a) => (a.type === "Text" ? { ...a, maximumLength: 4 } : a)),
    };
  expect(() => assertCatalogProductContentRegistrySuccessor(f, next)).not.toThrow();
  expect(() =>
    assertCatalogProductContentRegistrySuccessor(f, {
      ...next,
      previousSnapshotDigest: "sha256:" + "a".repeat(64),
    }),
  ).toThrow();
});
it("validates current registered values without granting reference or sale eligibility", () => {
  const r = validateCatalogProductRegisteredContent(
    candidate([
      {
        attributeReference: id(20),
        type: "Decimal",
        value: "99999999999999.999999",
        unitCode: "KG",
      },
      { attributeReference: id(21), type: "Text", value: "short" },
      { attributeReference: id(22), type: "Boolean", value: true },
      { attributeReference: id(23), type: "Enum", valueReference: id(30) },
    ]),
    fixture(),
  );
  expect(r.checks).toEqual(["TagRegistry", "AttributeRegistry"]);
  expect(r.referenceEligibility).toBe("NotEvaluated");
  expect(r.eligibility).toBe("NotEvaluated");
});
it.each([
  { attributeReference: id(20), type: "Decimal", value: "-0.500001", unitCode: "KG" },
  { attributeReference: id(20), type: "Decimal", value: "1", unitCode: "G" },
  { attributeReference: id(20), type: "Text", value: "1" },
  { attributeReference: id(21), type: "Text", value: "too long" },
  { attributeReference: id(23), type: "Enum", valueReference: id(99) },
  { attributeReference: id(99), type: "Boolean", value: false },
])("refuses current typed-reference mismatch %#", (value) =>
  expect(() => validateCatalogProductRegisteredContent(candidate([value]), fixture())).toThrow(),
);
it("refuses inactive tags, attributes and enum members", () => {
  const f = fixture();
  required(f.tags[0]).lifecycle = "Inactive";
  expect(() => validateCatalogProductRegisteredContent(candidate(), f)).toThrow();
  const g = fixture();
  required(g.attributes[0]).lifecycle = "Inactive";
  expect(() =>
    validateCatalogProductRegisteredContent(
      candidate([{ attributeReference: id(20), type: "Decimal", value: "0", unitCode: "KG" }]),
      g,
    ),
  ).toThrow();
  const h = fixture(),
    attribute = h.attributes.find((a) => a.type === "Enum");
  if (!attribute?.values?.[0]) throw new Error("fixture");
  attribute.values[0].lifecycle = "Retired";
  expect(() =>
    validateCatalogProductRegisteredContent(
      candidate([{ attributeReference: id(23), type: "Enum", valueReference: id(30) }]),
      h,
    ),
  ).toThrow();
});
it("binds exact original operation, expected version and tenant snapshot", () => {
  const c = parseCatalogContentRegistryCommand(command());
  expect(parseCatalogContentRegistryCommand(catalogContentRegistryRequest(c)).intentDigest).toBe(
    c.intentDigest,
  );
  for (const patch of [
    { tenantReference: id(99) },
    { brandReference: id(99) },
    { expectedRegistryVersion: 1 },
    { actorKind: "System" },
    { occurredAt: "2026-09-30T06:31:00.000Z" },
  ])
    expect(() => parseCatalogContentRegistryCommand({ ...command(), ...patch })).toThrow();
});
it("copies descriptors without invoking candidate or definition getters", () => {
  const f = fixture(),
    getter = vi.fn(() => []),
    value = Object.defineProperty({ ...f }, "attributes", { get: getter });
  expect(() => parseCatalogProductContentRegistry(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("refuses duplicated definition identity, missing default label, unsupported fields and floats", () => {
  const f = fixture();
  for (const value of [
    { ...f, tags: [...f.tags, f.tags[0]] },
    { ...f, tags: [{ ...f.tags[0], localizedNames: { "fr-CA": "Synthetic" } }] },
    { ...f, unknown: true },
    {
      ...f,
      attributes: f.attributes.map((a) => (a.type === "Decimal" ? { ...a, minimumValue: 0.5 } : a)),
    },
  ])
    expect(() => parseCatalogProductContentRegistry(value)).toThrow();
});
it("bounds current observation and preserves caller intent separately from registry history", () => {
  const value = {
    originalIntentDigest: "sha256:" + "a".repeat(64),
    observedAt: at,
    validUntil: "2026-09-30T06:30:30.000Z",
  };
  expect(parseCatalogContentRegistryObservation(value)).toEqual(value);
  expect(() =>
    parseCatalogContentRegistryObservation({ ...value, validUntil: "2026-09-30T06:30:30.001Z" }),
  ).toThrow();
});
