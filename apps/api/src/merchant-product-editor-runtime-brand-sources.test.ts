import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductAggregate,
  productEditorContentFields,
  productVariantCreationFields,
  productVariantHistoryFields,
  frozenFullOptionSetContentFields,
  contentRegistryFields,
  productCategoryAssignmentFields,
  parseCatalogProductContentRegistry,
  catalogProductDraftCategoryAssignmentPolicyV1,
  validateProductCategoryClassification,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
} from "@rms/catalog";
import { remainingProductEditorMediaSafetyChecks } from "./merchant-product-editor-media-safety-authority.js";
import { tenantBrandConfigurationRequiredFields } from "@bop/tenant";
import { currentProductPolicyFields } from "./current-product-publication-policy.js";
import {
  parseMerchantProductAuthoringSources,
  createMerchantProductEditorRuntimeBrandSources as create,
} from "./merchant-product-editor-runtime-brand-sources.js";
type Host = Parameters<typeof create>[0];
const owner = vi.hoisted(() => ({
  calls: [] as unknown[],
  tx: null as unknown,
  denied: false,
  locale: "en-CA",
  digest: "sha256:" + "a".repeat(64),
  until: "2026-10-04T22:00:05.000Z",
}));
// Source-composition fixtures only. Actual Tenant/Publishing SQL, governance and
// RLS are covered by owner/native tests; these tests do not manufacture releases.
vi.mock("./current-brand-configuration-content.js", () => ({
  createCurrentBrandConfigurationContentSource: () => ({
    async withCurrentContent(
      request: Record<string, unknown>,
      work: (packet: unknown, tx: unknown) => Promise<unknown>,
    ) {
      owner.calls.push(request);
      if (owner.denied) throw new Error("owning current Brand source unavailable");
      return work(
        {
          ...request,
          profile: "CurrentBrandConfigurationContentV1",
          brandVersion: request.expectedBrandVersion,
          contentDigest: owner.digest,
          currentPublicationReference: "019a2421-4000-7000-8000-00000000000b",
          defaultLocale: owner.locale,
          supportedLocales: [owner.locale],
          // Actual generic override metadata must not become Product requirements.
          hardRequirementFieldCodes: ["SECURITY.REAUTH"],
          overrideAllowedFieldCodes: [],
          validUntil: owner.until,
        },
        owner.tx,
      );
    },
  }),
}));
const id = (n: number) => "019a2421-4000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T22:00:00.000Z",
  until = "2026-10-04T22:00:05.000Z",
  unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
function fixture(action: "Create" | "ReplaceDraft" = "Create") {
  let now = at,
    denied = false;
  const guards: { guard(): Promise<void>; final(): void }[] = [],
    tx: Host["transaction"] = { query: async () => ({ rows: [] }) },
    authorize = vi.fn<Host["currentAuthorization"]["authorizeActions"]>(async () => {
      if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    host: Host = {
      transaction: tx,
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      sessionReference: id(5),
      productReference: id(6),
      operationReference: id(7),
      action,
      expectedAggregateVersion: action === "Create" ? null : 1,
      originalValidUntil: until,
      clock: { now: () => now },
      currentAuthorization: {
        authorizeActions: authorize,
        assertCurrent: () => parseCatalogInstant(now),
        withCurrentStoreScope: async () => {
          throw new Error("not a Store query");
        },
      },
      registerBeforeCommit: async (_tx, guard, final) => {
        guards.push({ guard, final });
      },
    },
    selected = {
      configurationVersionReference: id(8),
      expectedBrandVersion: 1,
      policyReference: id(9),
    },
    sources = create(host, selected),
    registry = parseCatalogProductContentRegistry({
      profile: "CatalogProductContentRegistryV1",
      tenantReference: id(1),
      brandReference: id(2),
      registryReference: id(12),
      versionReference: id(13),
      registryVersion: 1,
      defaultLocale: "en-CA",
      previousSnapshotDigest: null,
      registeredAt: at,
      tags: [],
      attributes: [],
    }),
    input = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User" as const,
      purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY" as const,
      permission: "catalog.manage" as const,
      action: "catalog.content-registry.read" as const,
      registry,
      requiredFields: contentRegistryFields,
      observedAt: at,
    },
    category = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      productReference: id(6),
      productVersionReference: id(10),
      purposeCode: "CATALOG_PRODUCT_CATEGORY_MUTATION" as const,
      permission: "catalog.product.manage" as const,
      referencedPermission: "catalog.manage" as const,
      requiredFields: productCategoryAssignmentFields,
      referencedFields: ["categoryReference", "brandReference", "lifecycle"] as const,
      observedAt: at,
    };
  owner.tx = tx;
  return {
    host,
    selected,
    sources,
    tx,
    input,
    category,
    authorize,
    clock: (value: string) => {
      now = value;
    },
    deny: () => {
      denied = true;
    },
    async commit() {
      for (const item of guards) await item.guard();
      for (const item of guards) item.final();
    },
  };
}
beforeEach(() => {
  owner.calls.length = 0;
  owner.denied = false;
  owner.locale = "en-CA";
  owner.digest = "sha256:" + "a".repeat(64);
  owner.until = until;
});
it.each(["Draft", "Active", "Inactive", "Archived"] as const)(
  "Catalog authoring policy V1 applies owning lifecycle %s",
  (lifecycle) => {
    const work = () =>
      validateProductCategoryClassification(
        { categoryReferences: [id(30)], primaryCategoryReference: id(30) },
        {
          brandReference: id(2),
          policy: catalogProductDraftCategoryAssignmentPolicyV1,
          categories: [
            {
              categoryReference: parseCatalogReference(id(30)),
              brandReference: parseCatalogReference(id(2)),
              lifecycle,
            },
          ],
        },
      );
    if (lifecycle === "Draft" || lifecycle === "Active")
      expect(work()).toMatchObject({ categoryReferences: [id(30)] });
    else expect(work).toThrow(CatalogError);
  },
);
it("registry and category acquire actual selected Brand content in the original UoW and recheck it at COMMIT", async () => {
  const f = fixture();
  await f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, f.input);
  expect(await f.sources.categoryPolicy(f.tx, f.category)).toBe(
    catalogProductDraftCategoryAssignmentPolicyV1,
  );
  expect(owner.calls[0]).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    configurationVersionReference: id(8),
    expectedBrandVersion: 1,
    purposeCode: "CATALOG_PRODUCT_CONTENT",
    observedAt: at,
    validUntil: until,
  });
  const reads = owner.calls.length;
  await f.commit();
  expect(owner.calls.length).toBe(reads + 1);
  await expect(f.sources.categoryPolicy(f.tx, f.category)).rejects.toMatchObject(unavailable);
});
it("does not evaluate generic hardRequirement codes as Product field requirements", async () => {
  const f = fixture();
  await f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, f.input);
  expect(Object.keys(f.sources)).toEqual([
    "brandAuthority",
    "creationAuthority",
    "historyAuthority",
    "optionAuthority",
    "remainingAuthority",
    "registryAuthority",
    "policyAuthority",
    "categoryPolicy",
    "admitStoredOperationRead",
    "withCurrentBrandContent",
  ]);
  await f.commit();
});
it("refuses unavailable owning Brand instead of empty policy defaults", async () => {
  const f = fixture();
  owner.denied = true;
  await expect(
    f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, f.input),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("refuses registry default locale disabled by current Brand", async () => {
  const f = fixture();
  owner.locale = "fr-CA";
  await expect(
    f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, f.input),
  ).rejects.toMatchObject(unavailable);
});
it("refuses registered localized names outside the actual supported locales", async () => {
  const f = fixture(),
    registry = parseCatalogProductContentRegistry({
      ...f.input.registry,
      tags: [
        {
          tagReference: id(30),
          code: "SYNTHETIC",
          localizedNames: { "en-CA": "Synthetic", "fr-CA": "Synthetic" },
          lifecycle: "Active",
        },
      ],
    });
  await expect(
    f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, { ...f.input, registry }),
  ).rejects.toMatchObject(unavailable);
});
it.each(["brandReference", "actorReference", "tenantReference"] as const)(
  "rejects changed registry %s before source read",
  async (key) => {
    const f = fixture();
    await expect(
      f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, {
        ...f.input,
        [key]: id(99),
      }),
    ).rejects.toMatchObject(unavailable);
    expect(owner.calls).toEqual([]);
  },
);
it("rejects foreign Product/category fields without acquiring a permissive policy", async () => {
  const f = fixture();
  await expect(
    f.sources.categoryPolicy(f.tx, { ...f.category, productReference: id(99) }),
  ).rejects.toMatchObject(unavailable);
  expect(owner.calls).toEqual([]);
});
it("retains original Brand content/release identity when final current reread changes", async () => {
  const f = fixture();
  await f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, f.input);
  owner.digest = "sha256:" + "b".repeat(64);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("retains actual fine permission through COMMIT", async () => {
  const f = fixture();
  await f.sources.categoryPolicy(f.tx, f.category);
  f.deny();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("retains original deadline and transaction query identity", async () => {
  const f = fixture();
  await f.sources.categoryPolicy(f.tx, f.category);
  f.clock(until);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
  const other = fixture();
  await other.sources.categoryPolicy(other.tx, other.category);
  other.tx.query = async () => ({ rows: [] });
  await expect(other.commit()).rejects.toMatchObject(unavailable);
});
it("uses only the fixed policy selector and full owning fields", async () => {
  const f = fixture(),
    input = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User" as const,
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION" as const,
      policyReference: id(9),
      requiredFields: currentProductPolicyFields,
      observedAt: at,
    };
  await f.sources.policyAuthority.holdUntilTransactionCompletes(f.tx, input);
  await f.commit();
  const denied = fixture();
  await expect(
    denied.sources.policyAuthority.holdUntilTransactionCompletes(denied.tx, {
      ...input,
      policyReference: id(99),
    }),
  ).rejects.toMatchObject(unavailable);
});
it("Brand authority validates exact source selector and complete fields rather than granting caller-selected fields", async () => {
  const f = fixture(),
    request = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      purposeCode: "CATALOG_PRODUCT_CONTENT" as const,
      configurationVersionReference: id(8),
      expectedBrandVersion: 1,
      originalIntentDigest: "sha256:" + "a".repeat(64),
      observedAt: at,
      validUntil: until,
    },
    work = vi.fn(async () => "value");
  expect(
    await f.sources.brandAuthority.withCurrentContentRead(
      request,
      tenantBrandConfigurationRequiredFields,
      work,
    ),
  ).toBe("value");
  await f.commit();
  const other = fixture();
  await expect(
    other.sources.brandAuthority.withCurrentContentRead(request, [], work),
  ).rejects.toMatchObject(unavailable);
});

function aggregate(
  root = 1,
  nutrition: { reference: string; versionReference: string } | null = null,
) {
  return parseProductAggregate({
    productReference: id(6),
    brandReference: id(2),
    internalCode: "RUNTIME_SOURCE_TEST",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: root,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(4),
    draft: {
      versionReference: id(10),
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
        media: [],
        tagReferences: [],
        attributeValues: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: nutrition,
      },
    },
  });
}
function creationInput() {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    actorKind: "User" as const,
    purposeCode: "CATALOG_PRODUCT_VARIANT_CREATION_CHECK" as const,
    permission: "catalog.product.history.read" as const,
    owningAction: "catalog.product.create" as const,
    requiredScope: "FullBrandScope" as const,
    request: {
      profile: "CatalogProductVariantCreationRequestV1" as const,
      operationReference: id(7),
      aggregate: aggregate(),
      originalIntentDigest: "sha256:" + "b".repeat(64),
      observedAt: at,
      validUntil: until,
    },
    requiredFields: productVariantCreationFields,
    observedAt: at,
    validUntil: until,
  };
}
function remainingInput(
  mode: "Read" | "DraftWrite",
  root: number,
  nutrition: { reference: string; versionReference: string } | null = null,
) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    productReference: id(6),
    operationReference: id(7),
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.manage" as const,
    purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
    observedAt: at,
    validUntil: until,
    mode,
    aggregate: aggregate(root, nutrition),
    requiredFields: productEditorContentFields,
    requiredReferenceChecks: mode === "Read" ? [] : remainingProductEditorMediaSafetyChecks,
  };
}
function storedRecord(value = aggregate(2)) {
  return {
    action: "ReplaceDraft",
    operationReference: id(7),
    operationIntentHash: "a".repeat(64),
    aggregate: value,
  };
}
function fullFrozenOptionInput() {
  const source = {
      optionSetReference: id(20),
      brandReference: id(2),
      internalCode: "HELD_OPTION",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(4),
      draft: {
        versionReference: id(21),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Held set" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection: 0,
        maximumSelection: 2,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 2,
        maximumTotalQuantity: 2,
        createdAt: at,
        updatedAt: at,
        options: [
          {
            optionReference: id(22),
            optionSetReference: id(20),
            brandReference: id(2),
            stableCode: "ONE",
            lifecycle: "Active",
            localizedNames: { "en-CA": "One" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: true,
            triggeredOptionSetReference: null,
            conflictOptionReferences: [],
            createdAt: at,
            createdByActorReference: id(4),
          },
        ],
      },
    },
    details = {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          optionReference: id(22),
          quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
    full = parseCatalogOptionSetEditorContent(source, details),
    content = createCatalogFullOptionSetPublicationMaterialization(source, details, {
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: id(20),
      versionReference: id(21),
      sourceAggregateVersion: 1,
      publicationOperationReference: id(23),
      publicationIntentDigest: "sha256:" + "a".repeat(64),
      successorDraftVersionReference: id(24),
      sealedAt: at,
      sourceDigest: full.sourceDigest,
      contentDigest: full.contentDigest,
      configurationDigest: full.configurationDigest,
    }).content;
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    actorKind: "User" as const,
    permission: "catalog.manage" as const,
    action: "catalog.option_set.read" as const,
    purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT" as const,
    requiredFields: frozenFullOptionSetContentFields,
    optionSetReference: id(20),
    versionReference: id(21),
    content,
    observedAt: at,
  };
}
it("validates real full Frozen Option inside the actual held Brand callback without generic reentry", async () => {
  const f = fixture("ReplaceDraft"),
    input = fullFrozenOptionInput();
  // Before the fix, this exact nested Option hold fails at activeBrandRead.
  await f.sources.withCurrentBrandContent(f.tx, async (brand) => {
    const calls = owner.calls.length;
    expect(await f.sources.optionAuthority.holdUntilTransactionCompletes(f.tx, input)).toEqual({
      observedAt: at,
      validUntil: until,
    });
    expect(owner.calls).toHaveLength(calls);
    expect(brand.observedAt).toBe(at);
    expect(f.authorize.mock.calls.slice(-3).map(([actions]) => actions)).toEqual([
      ["catalog.manage", "catalog.option_set.read"],
      ["catalog.manage", "catalog.product.read"],
      ["catalog.manage", "catalog.product.read"],
    ]);
  });
  expect(owner.calls).toHaveLength(1);
  await f.commit();
  expect(owner.calls).toHaveLength(2);
});
it("refuses a nested Option result when the last fresh permission hold crosses the shorter actual Brand lease", async () => {
  const f = fixture("ReplaceDraft"),
    input = fullFrozenOptionInput(),
    shorter = "2026-10-04T22:00:03.000Z";
  owner.until = shorter;
  await expect(
    f.sources.withCurrentBrandContent(f.tx, async () => {
      let productHolds = 0;
      f.authorize.mockImplementation(async (actions) => {
        if (actions.includes("catalog.product.read") && ++productHolds === 2) f.clock(shorter);
      });
      await expect(
        f.sources.optionAuthority.holdUntilTransactionCompletes(f.tx, input),
      ).rejects.toMatchObject(unavailable);
    }),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("continues to reject arbitrary Brand reentry even while an actual Brand is held", async () => {
  const f = fixture("ReplaceDraft");
  await expect(
    f.sources.withCurrentBrandContent(f.tx, async () => {
      await f.sources.withCurrentBrandContent(f.tx, async () => undefined);
    }),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it.each(["permission", "deadline", "scope", "content", "brandHead"])(
  "held nested Option validation refuses %s changes and poisons COMMIT",
  async (kind) => {
    const f = fixture("ReplaceDraft"),
      input = fullFrozenOptionInput();
    if (kind === "brandHead") {
      await f.sources.withCurrentBrandContent(f.tx, async () => {
        await f.sources.optionAuthority.holdUntilTransactionCompletes(f.tx, input);
      });
      owner.digest = "sha256:" + "b".repeat(64);
      await expect(f.commit()).rejects.toMatchObject(unavailable);
      return;
    }
    await expect(
      f.sources.withCurrentBrandContent(f.tx, async () => {
        if (kind === "permission") f.deny();
        if (kind === "deadline") f.clock(until);
        await f.sources.optionAuthority.holdUntilTransactionCompletes(f.tx, {
          ...input,
          brandReference: kind === "scope" ? id(25) : input.brandReference,
          content:
            kind === "content"
              ? { ...input.content, digest: "sha256:" + "b".repeat(64) }
              : input.content,
        });
      }),
    ).rejects.toMatchObject(
      kind === "permission" ? { code: "CATALOG_PERMISSION_DENIED" } : unavailable,
    );
    await expect(f.commit()).rejects.toMatchObject(
      kind === "permission" ? { code: "CATALOG_PERMISSION_DENIED" } : unavailable,
    );
  },
);
it("reads an owning immutable original successor without acquiring today's qualification or admitting a Write", async () => {
  const f = fixture("ReplaceDraft"),
    original = aggregate(2, { reference: id(20), versionReference: id(21) });
  await f.sources.admitStoredOperationRead(f.tx, storedRecord(original));
  await f.sources.remainingAuthority(f.tx, { ...remainingInput("Read", 2), aggregate: original });
  await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1));
  expect(owner.calls).toEqual([]);
  expect(f.authorize).toHaveBeenCalledWith([
    "catalog.content-registry.read",
    "catalog.manage",
    "catalog.option_set.read",
    "catalog.product.history.read",
    "catalog.product.read",
    "catalog.sku.read",
  ]);
  await expect(
    f.sources.remainingAuthority(f.tx, { ...remainingInput("DraftWrite", 2), aggregate: original }),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("keeps the recorded Read permission and original lease current until actual COMMIT", async () => {
  const f = fixture("ReplaceDraft");
  await f.sources.admitStoredOperationRead(f.tx, storedRecord());
  await f.sources.remainingAuthority(f.tx, remainingInput("Read", 2));
  f.deny();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  const expired = fixture("ReplaceDraft");
  await expired.sources.admitStoredOperationRead(expired.tx, storedRecord());
  expired.clock(until);
  await expect(expired.commit()).rejects.toMatchObject(unavailable);
});
it.each(["operation", "product", "action", "root", "transaction", "accessor"])(
  "rejects and poisons a non-owning stored admission: %s",
  async (kind) => {
    const f = fixture("ReplaceDraft"),
      record = storedRecord();
    if (kind === "operation") record.operationReference = id(22);
    if (kind === "product")
      record.aggregate = parseProductAggregate({ ...record.aggregate, productReference: id(22) });
    if (kind === "action") record.action = "Create";
    if (kind === "root") record.aggregate = aggregate(3);
    if (kind === "accessor")
      Object.defineProperty(record, "operationReference", {
        get: () => {
          throw new Error("accessor executed");
        },
        enumerable: true,
      });
    const actual = kind === "transaction" ? { query: f.tx.query } : f.tx;
    await expect(f.sources.admitStoredOperationRead(actual, record)).rejects.toMatchObject(
      unavailable,
    );
    await expect(f.commit()).rejects.toMatchObject(unavailable);
  },
);
it("refuses a different complete original record and same-root changed content after admission", async () => {
  for (const kind of ["hash", "content"] as const) {
    const f = fixture("ReplaceDraft"),
      record = storedRecord();
    await f.sources.admitStoredOperationRead(f.tx, record);
    await f.sources.admitStoredOperationRead(f.tx, record);
    const changed = parseProductAggregate({
      ...record.aggregate,
      draft: { ...record.aggregate.draft, localizedNames: { "en-CA": "Different original" } },
    });
    if (kind === "hash")
      await expect(
        f.sources.admitStoredOperationRead(f.tx, {
          ...record,
          operationIntentHash: "b".repeat(64),
        }),
      ).rejects.toMatchObject(unavailable);
    else
      await expect(
        f.sources.remainingAuthority(f.tx, { ...remainingInput("Read", 2), aggregate: changed }),
      ).rejects.toMatchObject(unavailable);
    await expect(f.commit()).rejects.toMatchObject(unavailable);
  }
});
it("holds actual Create permissions on the original absence request and refuses a changed operation", async () => {
  const f = fixture(),
    input = creationInput();
  await f.sources.creationAuthority.holdUntilTransactionCompletes(f.tx, input);
  expect(f.authorize).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.product.create",
    "catalog.product.history.read",
  ]);
  await expect(
    f.sources.creationAuthority.holdUntilTransactionCompletes(f.tx, {
      ...input,
      request: { ...input.request, operationReference: id(20) },
    }),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("keeps the exact pre-write root and retained history intent without manufacturing history", async () => {
  const f = fixture("ReplaceDraft"),
    input = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      permission: "catalog.product.history.read" as const,
      purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY" as const,
      request: {
        productReference: id(6),
        expectedAggregateVersion: 1,
        originalIntentDigest: "sha256:" + "b".repeat(64),
      },
      requiredFields: productVariantHistoryFields,
      observedAt: at,
    };
  await f.sources.historyAuthority.holdUntilTransactionCompletes(f.tx, input);
  await expect(
    f.sources.historyAuthority.holdUntilTransactionCompletes(f.tx, {
      ...input,
      request: { ...input.request, expectedAggregateVersion: 2 },
    }),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("uses held Brand and fixed Option read permission for the owning reader's initial absent-content hold", async () => {
  const f = fixture();
  await expect(
    f.sources.optionAuthority.holdUntilTransactionCompletes(f.tx, {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      permission: "catalog.manage",
      action: "catalog.option_set.read",
      purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT",
      requiredFields: frozenFullOptionSetContentFields,
      optionSetReference: id(20),
      versionReference: id(21),
      content: null,
      observedAt: at,
    }),
  ).resolves.toEqual({ observedAt: at, validUntil: until });
  expect(owner.calls).toHaveLength(1);
  expect(
    f.authorize.mock.calls.some(([actions]) => actions.includes("catalog.option_set.read")),
  ).toBe(true);
  await f.commit();
});
it("retains recorded Nutrition references during Read but refuses nonnull DraftWrite without a real producer", async () => {
  const f = fixture("ReplaceDraft"),
    nutrition = { reference: id(20), versionReference: id(21) };
  await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1, nutrition));
  await expect(
    f.sources.remainingAuthority(f.tx, remainingInput("DraftWrite", 2, nutrition)),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("accepts legitimate absent Nutrition after earlier owning checks and retains current permissions to COMMIT", async () => {
  const f = fixture("ReplaceDraft");
  await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1));
  await f.sources.remainingAuthority(f.tx, remainingInput("DraftWrite", 2));
  expect(f.authorize).toHaveBeenCalledWith([
    "catalog.content-registry.read",
    "catalog.manage",
    "catalog.option_set.read",
    "catalog.product.history.read",
    "catalog.product.read",
    "catalog.sku.read",
  ]);
  f.deny();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("rejects a foreign session in remaining complete-record access", async () => {
  const f = fixture("ReplaceDraft");
  await expect(
    f.sources.remainingAuthority(f.tx, { ...remainingInput("Read", 1), sessionReference: id(22) }),
  ).rejects.toMatchObject(unavailable);
});

it("captures exactly five ordinary startup selectors including the required owning policy version", () => {
  const selected = {
    configurationVersionReference: id(8),
    expectedBrandVersion: 1,
    policyReference: id(9),
    policyVersion: 2,
    allergenRegistryVersionReference: null,
  };
  const captured = parseMerchantProductAuthoringSources(selected);
  selected.policyVersion = 3;
  expect(captured.policyVersion).toBe(2);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(() =>
    parseMerchantProductAuthoringSources({ ...selected, permission: "catalog.manage" }),
  ).toThrow(CatalogError);
  expect(() => parseMerchantProductAuthoringSources({ ...selected, policyVersion: 0 })).toThrow(
    CatalogError,
  );
  const { policyVersion: _policy, ...missing } = selected;
  void _policy;
  expect(() => parseMerchantProductAuthoringSources(missing)).toThrow(CatalogError);
});

it("Create recorded Read holds complete fields and original rights without deriving absence, Brand or Nutrition eligibility", async () => {
  const f = fixture(),
    input = {
      ...remainingInput("Read", 1, { reference: id(20), versionReference: id(21) }),
      purposeCode: "CATALOG_PRODUCT_CREATE" as const,
    };
  // A stored original record may have been authored by a different Actor.
  const original = parseProductAggregate({ ...input.aggregate, createdByActorReference: id(22) });
  await f.sources.remainingAuthority(f.tx, { ...input, aggregate: original });
  expect(owner.calls).toEqual([]);
  expect(f.authorize).toHaveBeenCalledWith([
    "catalog.content-registry.read",
    "catalog.manage",
    "catalog.option_set.read",
    "catalog.product.history.read",
    "catalog.product.read",
    "catalog.sku.read",
  ]);
  await f.commit();
});
it("Create recorded Read does not admit a malformed initial root or qualification-check packet", async () => {
  const f = fixture(),
    input = { ...remainingInput("Read", 1), purposeCode: "CATALOG_PRODUCT_CREATE" as const };
  await expect(
    f.sources.remainingAuthority(f.tx, { ...input, aggregate: aggregate(2) }),
  ).rejects.toMatchObject(unavailable);
  expect(owner.calls).toEqual([]);
});
it("Create Write still rejects another creator after a legitimate recorded Read", async () => {
  const f = fixture(),
    read = { ...remainingInput("Read", 1), purposeCode: "CATALOG_PRODUCT_CREATE" as const };
  await f.sources.remainingAuthority(f.tx, read);
  const foreign = parseProductAggregate({ ...read.aggregate, createdByActorReference: id(22) });
  await expect(
    f.sources.remainingAuthority(f.tx, {
      ...read,
      mode: "DraftWrite",
      requiredReferenceChecks: remainingProductEditorMediaSafetyChecks,
      aggregate: foreign,
    }),
  ).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});

it("reads the exact own persisted Draft successor after original Read and admitted Write while retaining original history access", async () => {
  const f = fixture("ReplaceDraft"),
    original = remainingInput("Read", 1),
    write = remainingInput("DraftWrite", 2);
  await f.sources.remainingAuthority(f.tx, original);
  await f.sources.remainingAuthority(f.tx, write);
  await f.sources.remainingAuthority(f.tx, { ...write, mode: "Read", requiredReferenceChecks: [] });
  await f.sources.remainingAuthority(f.tx, original);
  expect(owner.calls).toEqual([]);
  expect(f.authorize).toHaveBeenCalledWith([
    "catalog.content-registry.read",
    "catalog.manage",
    "catalog.option_set.read",
    "catalog.product.history.read",
    "catalog.product.read",
    "catalog.sku.read",
  ]);
  await f.commit();
});
it("does not accept successor recorded Read before this host admits its exact DraftWrite", async () => {
  const f = fixture("ReplaceDraft");
  await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1));
  await expect(f.sources.remainingAuthority(f.tx, remainingInput("Read", 2))).rejects.toMatchObject(
    unavailable,
  );
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it.each(["changed-content", "later-root"] as const)(
  "refuses %s successor Read after an admitted DraftWrite",
  async (kind) => {
    const f = fixture("ReplaceDraft"),
      write = remainingInput("DraftWrite", 2);
    await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1));
    await f.sources.remainingAuthority(f.tx, write);
    const changed =
      kind === "later-root"
        ? aggregate(3)
        : parseProductAggregate({
            ...write.aggregate,
            draft: {
              ...write.aggregate.draft,
              localizedNames: { "en-CA": "Different persisted candidate" },
            },
          });
    await expect(
      f.sources.remainingAuthority(f.tx, {
        ...write,
        mode: "Read",
        requiredReferenceChecks: [],
        aggregate: changed,
      }),
    ).rejects.toMatchObject(unavailable);
    await expect(f.commit()).rejects.toMatchObject(unavailable);
  },
);
it("own successor Read still enforces current permission and refuses COMMIT after withdrawal", async () => {
  const f = fixture("ReplaceDraft"),
    write = remainingInput("DraftWrite", 2);
  await f.sources.remainingAuthority(f.tx, write);
  f.deny();
  await expect(
    f.sources.remainingAuthority(f.tx, { ...write, mode: "Read", requiredReferenceChecks: [] }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});

it("holds original registry Read rights without qualifying a null retained registry against today's Brand", async () => {
  const f = fixture();
  await f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, {
    ...f.input,
    registry: null,
  });
  expect(owner.calls).toEqual([]);
  await f.commit();
  expect(owner.calls).toEqual([]);
});
it("null retained registry Read still fails late permission revocation", async () => {
  const f = fixture();
  await f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, {
    ...f.input,
    registry: null,
  });
  f.deny();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(owner.calls).toEqual([]);
});

it("each source holds only its current action tuple and COMMIT reholds the complete union", async () => {
  const f = fixture("ReplaceDraft");
  await f.sources.historyAuthority.holdUntilTransactionCompletes(f.tx, {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    permission: "catalog.product.history.read",
    purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY",
    request: {
      productReference: id(6),
      expectedAggregateVersion: 1,
      originalIntentDigest: "sha256:" + "b".repeat(64),
    },
    requiredFields: productVariantHistoryFields,
    observedAt: at,
  });
  await f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, {
    ...f.input,
    registry: null,
  });
  await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1));
  expect(f.authorize.mock.calls.map(([actions]) => actions)).toEqual([
    ["catalog.manage", "catalog.product.history.read"],
    ["catalog.content-registry.read", "catalog.manage"],
    [
      "catalog.content-registry.read",
      "catalog.manage",
      "catalog.option_set.read",
      "catalog.product.history.read",
      "catalog.product.read",
      "catalog.sku.read",
    ],
  ]);
  await f.commit();
  expect(f.authorize).toHaveBeenLastCalledWith([
    "catalog.content-registry.read",
    "catalog.manage",
    "catalog.option_set.read",
    "catalog.product.history.read",
    "catalog.product.read",
    "catalog.sku.read",
  ]);
});
it("selected-only source holds do not reuse an earlier grant or extend its deadline", async () => {
  const f = fixture("ReplaceDraft");
  await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1));
  f.deny();
  await expect(
    f.sources.registryAuthority.holdUntilTransactionCompletes(f.tx, {
      ...f.input,
      registry: null,
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  const expired = fixture("ReplaceDraft");
  await expired.sources.remainingAuthority(expired.tx, remainingInput("Read", 1));
  expired.clock(until);
  await expect(
    expired.sources.registryAuthority.holdUntilTransactionCompletes(expired.tx, {
      ...expired.input,
      registry: null,
    }),
  ).rejects.toMatchObject(unavailable);
  expect(expired.authorize).toHaveBeenCalledOnce();
});

it.each([
  "catalog.content-registry.read",
  "catalog.product.history.read",
  "catalog.option_set.read",
])(
  "complete runtime preserves late withdrawal of %s despite absent optional references",
  async (withdrawn) => {
    const f = fixture("ReplaceDraft");
    await f.sources.remainingAuthority(f.tx, remainingInput("Read", 1));
    await f.sources.remainingAuthority(f.tx, remainingInput("DraftWrite", 2));
    expect(f.authorize.mock.calls.every(([actions]) => actions.includes(withdrawn))).toBe(true);
    f.authorize.mockImplementation(async (actions) => {
      if (actions.includes(withdrawn)) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  },
);
