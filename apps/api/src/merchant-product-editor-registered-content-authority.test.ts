import { expect, it, vi } from "vitest";
import {
  CatalogError,
  catalogContentRegistryEventId,
  catalogContentRegistryRequest,
  parseCatalogContentRegistryCommand,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "@rms/catalog";
import {
  createMerchantProductEditorRegisteredContentAuthority as create,
  remainingProductEditorReferenceChecks,
} from "./merchant-product-editor-registered-content-authority.js";
import { createMerchantProductEditorContentAuthority } from "./merchant-product-editor-content-authority.js";
const id = (n: number) => `019a2445-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-30T23:00:00.000Z";
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type Options = Parameters<typeof create>[0];
function fixture() {
  let clock = at;
  const registry = {
    profile: "CatalogProductContentRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(10),
    versionReference: id(11),
    registryVersion: 1,
    defaultLocale: "en-CA",
    previousSnapshotDigest: null,
    registeredAt: at,
    tags: [
      {
        tagReference: id(20),
        code: "TAG",
        localizedNames: { "en-CA": "Synthetic" },
        lifecycle: "Active",
      },
    ],
    attributes: [
      {
        attributeReference: id(21),
        code: "WEIGHT",
        localizedNames: { "en-CA": "Synthetic" },
        lifecycle: "Active",
        type: "Decimal",
        unitCode: "KG",
        minimumValue: "0",
        maximumValue: "10",
      },
    ],
  };
  const aggregate = parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 2,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(4),
    draft: {
      versionReference: id(30),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [],
      optionBindings: [],
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [id(20)],
        attributeValues: [
          { attributeReference: id(21), type: "Decimal", value: "1.25", unitCode: "KG" },
        ],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
  const input = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(6),
    productReference: id(5),
    operationReference: id(7),
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.manage" as const,
    purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
    observedAt: at,
    validUntil: "2026-09-30T23:00:05.000Z",
    mode: "DraftWrite" as const,
    aggregate,
    requiredFields: productEditorContentFields,
    requiredReferenceChecks: productEditorContentReferenceChecks,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("count(*)::text n")) return { rows: [{ n: "1", bytes: "1024" }] };
    if (sql.includes("command_json command")) {
      const command = parseCatalogContentRegistryCommand({
        purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User",
        operationReference: id(12),
        expectedRegistryVersion: 0,
        occurredAt: registry.registeredAt,
        reasonCode: "SYNTHETIC",
        registry,
      });
      return {
        rows: [
          {
            command: catalogContentRegistryRequest(command),
            registry: command.registry,
            intent_digest: command.intentDigest,
            snapshot_digest: command.snapshotDigest,
            event_id: catalogContentRegistryEventId(command),
            coherent: true,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const tx = { query } as unknown as Parameters<ReturnType<typeof create>>[0];
  const registryHold = vi.fn<Options["registryAuthority"]["holdUntilTransactionCompletes"]>(
    async () => undefined,
  );
  const remaining = vi.fn<Options["remainingAuthority"]>(async () => undefined);
  const options: Options = {
    registryAuthority: { holdUntilTransactionCompletes: registryHold },
    remainingAuthority: remaining,
    clock: { now: () => clock },
  };
  const authority = create(options);
  return {
    registry,
    aggregate,
    input,
    tx,
    query,
    registryHold,
    remaining,
    options,
    authority,
    clock: (next: string) => {
      clock = next;
    },
  };
}
it("joins actual owning registry reader/rules to the caller transaction, leaving six mandatory checks", async () => {
  const f = fixture();
  await expect(f.authority(f.tx, f.input)).resolves.toBeUndefined();
  expect(f.registryHold).toHaveBeenCalledTimes(3);
  expect(f.registryHold).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      action: "catalog.content-registry.read",
      purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
    }),
  );
  expect(f.remaining).toHaveBeenCalledOnce();
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      aggregate: f.aggregate,
      observedAt: f.input.observedAt,
      validUntil: f.input.validUntil,
      requiredFields: productEditorContentFields,
      requiredReferenceChecks: remainingProductEditorReferenceChecks,
    }),
  );
  expect(remainingProductEditorReferenceChecks).toEqual([
    "BrandContentPolicy",
    "Media",
    "OptionSet",
    "VariantIdentityHistory",
    "SafetyVocabulary",
    "Nutrition",
  ]);
  expect(f.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(
    true,
  );
  expect(
    f.query.mock.calls.every(([sql]) => !/COMMIT|ROLLBACK|BEGIN|INSERT|UPDATE/.test(sql)),
  ).toBe(true);
});
it("reads require complete fields without resolving stored references as current eligibility", async () => {
  const f = fixture();
  await f.authority(f.tx, { ...f.input, mode: "Read", requiredReferenceChecks: [] });
  expect(f.query).not.toHaveBeenCalled();
  expect(f.registryHold).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ mode: "Read", requiredReferenceChecks: [] }),
  );
});
it.each([
  ["missing tag", { tagReferences: [id(99)] }],
  [
    "missing attribute",
    {
      attributeValues: [
        { attributeReference: id(99), type: "Decimal", value: "1", unitCode: "KG" },
      ],
    },
  ],
  [
    "wrong unit",
    {
      attributeValues: [{ attributeReference: id(21), type: "Decimal", value: "1", unitCode: "G" }],
    },
  ],
  [
    "range",
    {
      attributeValues: [
        { attributeReference: id(21), type: "Decimal", value: "10.000001", unitCode: "KG" },
      ],
    },
  ],
  [
    "wrong type",
    { attributeValues: [{ attributeReference: id(21), type: "Text", value: "Synthetic" }] },
  ],
])("owning registry rules reject %s before remaining holder", async (_label, patch) => {
  const f = fixture();
  const aggregate = parseProductAggregate({
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      editorContent: { ...f.aggregate.draft.editorContent, ...patch },
    },
  });
  await expect(f.authority(f.tx, { ...f.input, aggregate })).rejects.toMatchObject({
    code: "CATALOG_LIFECYCLE_CONFLICT",
  });
  expect(f.remaining).not.toHaveBeenCalled();
});
it.each(["Inactive", "Retired"])("rejects current %s registered tag", async (lifecycle) => {
  const f = fixture();
  const tag = f.registry.tags[0];
  if (!tag) throw new Error("Missing synthetic tag");
  tag.lifecycle = lifecycle;
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject({
    code: "CATALOG_LIFECYCLE_CONFLICT",
  });
  expect(f.remaining).not.toHaveBeenCalled();
});
it.each([
  "brandReference",
  "productReference",
  "mode",
  "purposeCode",
  "owningAction",
  "permission",
  "requiredFields",
  "requiredReferenceChecks",
  "validUntil",
])("rejects changed %s before owning query", async (key) => {
  const f = fixture();
  await expect(
    f.authority(f.tx, {
      ...f.input,
      [key]: key.includes("Reference") ? id(99) : "Unknown",
    } as never),
  ).rejects.toThrow(CatalogError);
  expect(f.query).not.toHaveBeenCalled();
  expect(f.remaining).not.toHaveBeenCalled();
});
it("rejects supplied source qualification and nested getters without invoking them", async () => {
  const f = fixture(),
    get = vi.fn(() => "TagRegistry");
  await expect(
    f.authority(f.tx, { ...f.input, registry: f.registry } as never),
  ).rejects.toMatchObject(unavailable);
  await expect(
    f.authority(f.tx, {
      ...f.input,
      requiredReferenceChecks: [
        {
          get name() {
            return get();
          },
        },
      ],
    } as never),
  ).rejects.toThrow(CatalogError);
  expect(get).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it.each(["registryAuthority", "remainingAuthority", "clock"])(
  "missing %s configuration refuses",
  (key) => {
    const f = fixture();
    expect(() => create({ ...f.options, [key]: undefined } as never)).toThrow(CatalogError);
  },
);
it.each(["2026-09-30T22:59:59.999Z", "2026-09-30T23:00:05.000Z"])(
  "retains exclusive original clock %s",
  async (clock) => {
    const f = fixture();
    f.clock(clock);
    await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it("fails on empty current registry instead of accepting missing reference coverage", async () => {
  const f = fixture();
  f.query.mockImplementation(async (sql) =>
    sql.includes("transaction_isolation")
      ? { rows: [{ isolation: "read committed" }] }
      : sql.includes("count(*)::text n")
        ? { rows: [{ n: "0", bytes: "0" }] }
        : { rows: [] },
  );
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  expect(f.remaining).not.toHaveBeenCalled();
});
it("remaining holder must return undefined and retain original deadline", async () => {
  const f = fixture();
  f.remaining.mockResolvedValue("Allowed" as never);
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  f.remaining.mockImplementation(async () => {
    f.clock(f.input.validUntil);
  });
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
});
it("keeps late owning authority denial distinct and bounds unknown failures", async () => {
  const f = fixture();
  f.registryHold.mockImplementation(async () => {
    if (f.registryHold.mock.calls.length === 3) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.remaining).toHaveBeenCalledOnce();
  f.registryHold.mockRejectedValue(new Error("Synthetic private failure"));
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
});
it("captures configured collaborators before method rebound", async () => {
  const f = fixture();
  f.options.registryAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("Changed source");
  };
  f.options.clock.now = () => f.input.validUntil;
  await expect(f.authority(f.tx, f.input)).resolves.toBeUndefined();
  expect(f.registryHold).toHaveBeenCalledTimes(3);
});
it("outer complete guard rechecks actual registered definitions through final COMMIT hold", async () => {
  const f = fixture(),
    checks: (() => Promise<void>)[] = [];
  const guard = createMerchantProductEditorContentAuthority({
    transaction: f.tx,
    scope: {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
      actorReference: id(4),
      authorizeAction: async (action: string) => ({ action, effect: "Allow", scopeKind: "Brand" }),
    } as never,
    sessionReference: id(6),
    productReference: id(5),
    operationReference: id(7),
    authority: f.authority,
    now: () => at,
    registerBeforeCommit: async (_tx, check) => {
      checks.push(check);
    },
  });
  await guard.holdUntilTransactionCompletes(f.tx, {
    mode: "DraftWrite",
    aggregate: f.aggregate,
    requiredFields: productEditorContentFields,
    requiredReferenceChecks: productEditorContentReferenceChecks,
  });
  const tag = f.registry.tags[0];
  if (!tag) throw new Error("Missing synthetic tag");
  tag.lifecycle = "Inactive";
  const finish = checks[0];
  if (!finish) throw new Error("Missing synthetic final guard");
  await expect(finish()).rejects.toMatchObject({ code: "CATALOG_LIFECYCLE_CONFLICT" });
  expect(() => guard.assertCurrent()).toThrow(CatalogError);
});

it("rejects a foreign Tenant owning registry before remaining fields or reference acceptance", async () => {
  const f = fixture();
  await expect(f.authority(f.tx, { ...f.input, tenantReference: id(99) })).rejects.toMatchObject(
    unavailable,
  );
  expect(f.registryHold).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ tenantReference: id(99) }),
  );
  expect(f.query).toHaveBeenCalled();
  expect(f.remaining).not.toHaveBeenCalled();
});

it("unknown registry authority result never grants source acceptance", async () => {
  const f = fixture();
  f.registryHold.mockResolvedValue("Allowed" as never);
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  expect(f.query).not.toHaveBeenCalled();
  expect(f.remaining).not.toHaveBeenCalled();
});
it("empty configured references still require an actual current registry", async () => {
  const f = fixture();
  f.query.mockImplementation(async (sql) =>
    sql.includes("transaction_isolation")
      ? { rows: [{ isolation: "read committed" }] }
      : sql.includes("count(*)::text n")
        ? { rows: [{ n: "0", bytes: "0" }] }
        : { rows: [] },
  );
  const aggregate = parseProductAggregate({
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      editorContent: { ...f.aggregate.draft.editorContent, tagReferences: [], attributeValues: [] },
    },
  });
  await expect(f.authority(f.tx, { ...f.input, aggregate })).rejects.toMatchObject(unavailable);
  expect(f.remaining).not.toHaveBeenCalled();
});
