import { expect, it, vi } from "vitest";
import { createMediaAsset, createMediaAssetVersion, createMediaScope } from "@bop/media";
import {
  CatalogError,
  parseCatalogInstant,
  parseProductAggregate,
  productEditorContentFields,
} from "@rms/catalog";
import { remainingProductEditorVariantReferenceChecks } from "./merchant-product-editor-variant-content-authority.js";
import { createMerchantProductEditorRuntimeMediaSafetyAuthority as create } from "./merchant-product-editor-runtime-media-safety.js";
const id = (n: number) => "019a2421-3000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T21:00:00.000Z",
  until = "2026-10-04T21:00:05.000Z",
  digest = "sha256:" + "a".repeat(64),
  unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type Host = Parameters<typeof create>[0];
type Options = Parameters<typeof create>[1];
type Tx = Host["transaction"];
// Actual owning readers/parsers execute over controlled SQL and authority fixtures.
// Native RLS, locking, IAM and external image processing are not inferred here.
function fixture(mode: "Create" | "ReplaceDraft" = "Create", selected = true) {
  let now = at,
    missing = false,
    denied = false,
    safetyDenied = false,
    lease = until;
  const scope = createMediaScope({
      kind: "Brand",
      brandReference: id(2),
      storeReference: null,
    } as Parameters<typeof createMediaScope>[0]),
    asset = createMediaAsset({
      assetId: id(10),
      scope,
      purpose: "PRODUCT_IMAGE",
      mediaKind: "Image",
      ownerType: "PRODUCT",
      ownerReference: id(6),
      classification: "Public",
      version: 1,
      currentVersionReference: null,
    } as Parameters<typeof createMediaAsset>[0]),
    version = createMediaAssetVersion({
      assetVersionId: id(11),
      assetId: id(10),
      version: 1,
      objectEvidenceReference: id(12),
      providerObjectVersion: id(13),
      byteSize: 234,
      checksum: digest,
      contentType: "image/png",
      checkState: "Quarantined",
      readinessState: "Pending",
      createdAt: at,
    } as Parameters<typeof createMediaAssetVersion>[0]),
    mediaRow = {
      asset,
      version,
      coherent: true,
      intent: null,
      intent_digest: null,
      plan_digest: null,
      completion: null,
      completion_digest: null,
      completed_asset: null,
      completed_version: null,
      completed_at: null,
      source_config: null,
      admission: null,
      admission_digest: null,
      provenance_coherent: false,
    };
  let facts: unknown = {
    registryVersionReference: id(15),
    brandReference: id(2),
    jurisdictionCode: "CA-ON",
    policyDocumentDigest: digest,
    reviewedAt: at,
    reviewerActorReference: id(16),
    status: "Approved",
    entries: [
      {
        allergenReference: id(17),
        code: "SYNTHETIC_A",
        localizedNames: { "en-CA": "Synthetic vocabulary" },
      },
    ],
  };
  const sql: string[] = [],
    guards: { work: () => Promise<void>; final: () => void }[] = [];
  const tx: Tx = {
    async query<Row>(text: string) {
      sql.push(text);
      const rows = text.startsWith("SELECT current_setting('bop.tenant_id'")
        ? [
            {
              tenant_reference: id(1),
              brand_reference: id(2),
              store_reference: null,
              isolation: "read committed",
            },
          ]
        : text.includes("transaction_isolation")
          ? [{ isolation: "read committed" }]
          : text.includes("FROM bop_media.asset_version v JOIN")
            ? missing
              ? []
              : [mediaRow]
            : text.includes("SELECT jsonb_build_object(")
              ? [{ facts, coherent: true }]
              : [];
      return { rows: rows as unknown as readonly Row[] };
    },
  };
  const authorize = vi.fn<Host["currentAuthorization"]["authorizeActions"]>(async (actions) => {
      if (denied || (safetyDenied && actions.includes("catalog.manage")))
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    assertCurrent = vi.fn(() => {
      if (now >= lease) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return parseCatalogInstant(lease);
    }),
    remaining = vi.fn<Options["remainingAuthority"]>(async () => undefined),
    register = vi.fn<Host["registerBeforeCommit"]>(async (actual, work, final) => {
      expect(actual).toBe(tx);
      guards.push({ work, final });
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
      action: mode,
      expectedAggregateVersion: mode === "Create" ? null : 1,
      originalValidUntil: until,
      currentAuthorization: {
        authorizeActions: authorize,
        assertCurrent,
        withCurrentStoreScope: async () => {
          throw new Error("not a Store source");
        },
      },
      clock: { now: () => now },
      registerBeforeCommit: register,
    },
    options: Options = {
      allergenRegistryVersionReference: selected ? id(15) : null,
      remainingAuthority: remaining,
    },
    authority = create(host, options),
    aggregate = parseProductAggregate({
      productReference: id(6),
      brandReference: id(2),
      internalCode: "EDITOR_MEDIA_SAFETY",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: mode === "Create" ? 1 : 2,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(4),
      draft: {
        versionReference: id(8),
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
          media: [
            {
              mediaReference: id(9),
              assetReference: id(10),
              assetVersionReference: id(11),
              role: "Primary",
              altText: { "en-CA": "Synthetic" },
              sortOrder: 0,
              cropReference: null,
              focusReference: null,
            },
          ],
          tagReferences: [],
          attributeValues: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [id(17)],
          nutritionProfile: null,
        },
      },
    }),
    input = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      sessionReference: id(5),
      productReference: id(6),
      operationReference: id(7),
      permission: "catalog.manage" as const,
      owningAction: "catalog.product.manage" as const,
      purposeCode:
        mode === "Create"
          ? ("CATALOG_PRODUCT_CREATE" as const)
          : ("CATALOG_PRODUCT_DRAFT_REPLACE" as const),
      observedAt: at,
      validUntil: until,
      mode: "DraftWrite" as const,
      aggregate,
      requiredFields: productEditorContentFields,
      requiredReferenceChecks: remainingProductEditorVariantReferenceChecks,
    };
  return {
    tx,
    sql,
    guards,
    authority,
    input,
    aggregate,
    authorize,
    assertCurrent,
    host,
    remaining,
    options,
    mediaRow,
    clock: (value: string) => {
      now = value;
    },
    missing: () => {
      missing = true;
    },
    denyMedia: () => {
      denied = true;
    },
    denySafety: () => {
      safetyDenied = true;
    },
    lease: (value: string) => {
      lease = value;
    },
    facts: (value: unknown) => {
      facts = value;
    },
    async commit() {
      for (const g of guards) await g.work();
      for (const g of guards) g.final();
    },
  };
}

it.each(["Create", "ReplaceDraft"] as const)(
  "%s composes actual Media/dictionary SQL with fixed current IAM through COMMIT",
  async (mode) => {
    const f = fixture(mode);
    await f.authority(f.tx, f.input);
    expect(f.sql.some((sql) => sql.includes("FROM bop_media.asset_version v JOIN"))).toBe(true);
    expect(f.sql.some((sql) => sql.includes("FROM rms_catalog.allergen_registry_version"))).toBe(
      true,
    );
    expect(f.authorize).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.product.manage",
      "media.asset.access",
    ]);
    await f.commit();
    await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  },
);
it("retains original SQL proof after own write and still reholds current IAM at COMMIT", async () => {
  const f = fixture("ReplaceDraft");
  await f.authority(f.tx, f.input);
  const reads = f.sql.length;
  f.missing();
  await f.authority(f.tx, f.input);
  expect(f.sql).toHaveLength(reads);
  f.denyMedia();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "sessionReference",
  "productReference",
  "operationReference",
] as const)("rejects changed original %s before source reads", async (key) => {
  const f = fixture();
  await expect(f.authority(f.tx, { ...f.input, [key]: id(90) })).rejects.toMatchObject(unavailable);
  expect(f.sql).toEqual([]);
});
it("rejects changed original expected root before actual source SQL", async () => {
  const f = fixture("ReplaceDraft");
  const authority = create({ ...f.host, expectedAggregateVersion: 2 }, f.options);
  await expect(authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  // The first actual owner checks context before reading assets; no asset/dictionary facts consumed.
  expect(f.sql.some((sql) => sql.includes("FROM bop_media.asset_version v JOIN"))).toBe(false);
});
it("enforces a shortened actual authorization lease before COMMIT", async () => {
  const f = fixture();
  await f.authority(f.tx, f.input);
  f.lease("2026-10-04T21:00:02.000Z");
  f.clock("2026-10-04T21:00:02.000Z");
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("refuses missing selected dictionary instead of treating it as an empty approved profile", async () => {
  const f = fixture("Create", false);
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("does not query dictionary for a truly empty selection", async () => {
  const f = fixture("Create", false);
  const aggregate = parseProductAggregate({
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      editorContent: { ...f.aggregate.draft.editorContent, allergenReferences: [] },
    },
  });
  await f.authority(f.tx, { ...f.input, aggregate });
  expect(f.sql.some((sql) => sql.includes("FROM rms_catalog.allergen_registry_version"))).toBe(
    false,
  );
  await f.commit();
});
it("rejects query replacement and original expiry without new source SQL", async () => {
  const f = fixture();
  await f.authority(f.tx, f.input);
  f.tx.query = vi.fn(async () => ({ rows: [] }));
  await expect(f.commit()).rejects.toMatchObject(unavailable);
  const expired = fixture();
  expired.clock(until);
  await expect(expired.authority(expired.tx, expired.input)).rejects.toMatchObject(unavailable);
  expect(expired.sql).toEqual([]);
});

it("poisons swallowed registration reentry before any source reads", async () => {
  const f = fixture();
  const authority: ReturnType<typeof create> = create(
    {
      ...f.host,
      registerBeforeCommit: async (...args) => {
        await expect(authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
        await f.host.registerBeforeCommit(...args);
      },
    },
    f.options,
  );
  await expect(authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  expect(f.sql).toEqual([]);
});
it("rejects a malformed editor lease before source reads", async () => {
  const f = fixture();
  await expect(
    f.authority(f.tx, { ...f.input, validUntil: "2026-10-04T21:00:06.000Z" }),
  ).rejects.toMatchObject(unavailable);
  expect(f.sql).toEqual([]);
});

it("clamps a later editor lease to the original host deadline without renewing request admission", async () => {
  const f = fixture(),
    earlier = "2026-10-04T21:00:04.000Z",
    authority = create({ ...f.host, originalValidUntil: earlier }, f.options);
  await authority(f.tx, f.input);
  f.clock(earlier);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});

it("Media and Safety rehold their own required tuple while COMMIT retains their union", async () => {
  const f = fixture("ReplaceDraft");
  await f.authority(f.tx, f.input);
  const mediaActions = ["catalog.manage", "catalog.product.manage", "media.asset.access"],
    safetyActions = ["catalog.manage", "catalog.product.manage"],
    batches = f.authorize.mock.calls.map(([actions]) => actions);
  expect(batches).toContainEqual(mediaActions);
  expect(batches).toContainEqual(safetyActions);
  expect(
    batches.every(
      (actions) =>
        JSON.stringify(actions) === JSON.stringify(mediaActions) ||
        JSON.stringify(actions) === JSON.stringify(safetyActions),
    ),
  ).toBe(true);
  const beforeCommit = f.authorize.mock.calls.length;
  await f.commit();
  expect(f.authorize.mock.calls.slice(beforeCommit).map(([actions]) => actions)).toContainEqual(
    mediaActions,
  );
});
it("COMMIT rechecks earlier Media rights after subsequent Safety holds", async () => {
  const f = fixture("ReplaceDraft");
  await f.authority(f.tx, f.input);
  f.authorize.mockImplementation(async (actions) => {
    if (actions.includes("media.asset.access")) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.authorize).toHaveBeenLastCalledWith([
    "catalog.manage",
    "catalog.product.manage",
    "media.asset.access",
  ]);
});
