import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createMediaAsset, createMediaAssetVersion, createMediaScope } from "@bop/media";
import { CatalogError, parseProductAggregate, productEditorContentFields } from "@rms/catalog";
import { remainingProductEditorVariantReferenceChecks } from "./merchant-product-editor-variant-content-authority.js";
import {
  createMerchantProductEditorMediaSafetyAuthority as create,
  remainingProductEditorMediaSafetyChecks,
} from "./merchant-product-editor-media-safety-authority.js";
const id = (n: number) => "019a2421-3000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T21:00:00.000Z",
  until = "2026-10-04T21:00:05.000Z",
  digest = "sha256:" + "a".repeat(64),
  unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type Options = Parameters<typeof create>[0];
type Tx = Parameters<Options["registerBeforeCommit"]>[0];
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
  const mediaHold = vi.fn<Options["mediaAuthority"]["holdUntilTransactionCompletes"]>(
      async (_tx, input) => {
        if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return { observedAt: input.request.observedAt, validUntil: lease };
      },
    ),
    safetyHold = vi.fn<Options["safetyAuthority"]["holdUntilTransactionCompletes"]>(async () => {
      if (safetyDenied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    remaining = vi.fn<Options["remainingAuthority"]>(async () => undefined),
    register = vi.fn<Options["registerBeforeCommit"]>(async (actual, work, final) => {
      expect(actual).toBe(tx);
      guards.push({ work, final });
    }),
    options: Options = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      allergenRegistryVersionReference: selected ? id(15) : null,
      mediaAuthority: { holdUntilTransactionCompletes: mediaHold },
      safetyAuthority: { holdUntilTransactionCompletes: safetyHold },
      remainingAuthority: remaining,
      clock: { now: () => now },
      registerBeforeCommit: register,
    },
    authority = create(options),
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
    mediaHold,
    safetyHold,
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
  "%s runs actual editor Media/approved vocabulary with exact full candidate and original purpose",
  async (mode) => {
    const f = fixture(mode);
    await f.authority(f.tx, f.input);
    expect(f.mediaHold).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        request: expect.objectContaining({
          intentKind: mode === "Create" ? "EditorCreate" : "DraftReplace",
          expectedAggregateVersion: mode === "Create" ? 0 : 1,
          aggregateSnapshotDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(f.aggregate)),
          operationReference: id(7),
        }),
      }),
    );
    expect(f.safetyHold).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        request: expect.objectContaining({
          aggregate: f.aggregate,
          registryVersionReference: id(15),
        }),
      }),
    );
    expect(f.remaining).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        aggregate: f.aggregate,
        purposeCode: f.input.purposeCode,
        requiredReferenceChecks: remainingProductEditorMediaSafetyChecks,
      }),
    );
    expect(remainingProductEditorMediaSafetyChecks).toEqual([
      "BrandContentPolicy",
      "OptionSet",
      "Nutrition",
    ]);
    await f.commit();
  },
);
it("retains original held sources across rechecks without rereading after own mutation", async () => {
  const f = fixture();
  await f.authority(f.tx, f.input);
  const count = f.sql.length;
  f.missing();
  f.facts(null);
  f.clock("2026-10-04T21:00:01.000Z");
  await f.authority(f.tx, f.input);
  await f.commit();
  expect(f.sql).toHaveLength(count);
  expect(f.remaining).toHaveBeenCalledTimes(2);
});
it("Read does not reacquire reference or publication qualification", async () => {
  const f = fixture("ReplaceDraft");
  await f.authority(f.tx, { ...f.input, mode: "Read", requiredReferenceChecks: [] });
  expect(f.sql).toEqual([]);
  expect(f.mediaHold).not.toHaveBeenCalled();
  expect(f.safetyHold).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ requiredReferenceChecks: [] }),
  );
  await f.commit();
});
it("empty explicit vocabulary selection produces no fictional dictionary or safety claim", async () => {
  const f = fixture("Create", false),
    aggregate = parseProductAggregate({
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        editorContent: { ...f.aggregate.draft.editorContent, allergenReferences: [] },
      },
    });
  await f.authority(f.tx, { ...f.input, aggregate });
  expect(f.safetyHold).not.toHaveBeenCalled();
  expect(f.sql.some((sql) => sql.includes("allergen_registry_version"))).toBe(false);
  await f.commit();
});
it("nonempty vocabulary requires a real selected registry", async () => {
  const f = fixture("Create", false);
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  expect(f.remaining).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("missing media is refused rather than relabelled recorded or ready", async () => {
  const f = fixture();
  f.missing();
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  expect(f.remaining).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toThrow();
});
it("missing selected vocabulary member remains a concrete business conflict", async () => {
  const f = fixture();
  f.facts({
    registryVersionReference: id(15),
    brandReference: id(2),
    jurisdictionCode: "CA-ON",
    policyDocumentDigest: digest,
    reviewedAt: at,
    reviewerActorReference: id(16),
    status: "Approved",
    entries: [],
  });
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject({
    code: "CATALOG_LIFECYCLE_CONFLICT",
  });
  expect(f.remaining).not.toHaveBeenCalled();
});
it.each(["candidate", "operation", "scope", "lease"])(
  "changed original %s poisons retained proof",
  async (kind) => {
    const f = fixture();
    await f.authority(f.tx, f.input);
    const input =
      kind === "candidate"
        ? {
            ...f.input,
            aggregate: parseProductAggregate({
              ...f.aggregate,
              draft: { ...f.aggregate.draft, localizedNames: { "en-CA": "Changed" } },
            }),
          }
        : kind === "operation"
          ? { ...f.input, operationReference: id(99) }
          : kind === "scope"
            ? { ...f.input, storeReference: id(99) }
            : {
                ...f.input,
                observedAt: "2026-10-04T21:00:01.000Z",
                validUntil: "2026-10-04T21:00:06.000Z",
              };
    await expect(f.authority(f.tx, input)).rejects.toMatchObject(unavailable);
    await expect(f.commit()).rejects.toMatchObject(unavailable);
  },
);
it.each(["expiry", "query", "mediaDenial", "safetyDenial"])(
  "COMMIT rejects %s after valid reference admission",
  async (kind) => {
    const f = fixture();
    await f.authority(f.tx, f.input);
    if (kind === "expiry") f.clock(until);
    else if (kind === "query") Object.assign(f.tx, { query: vi.fn(async () => ({ rows: [] })) });
    else if (kind === "mediaDenial") f.denyMedia();
    else f.denySafety();
    await expect(f.commit()).rejects.toThrow();
  },
);
it("shorter source authority lease cannot be renewed by repeated editor checks", async () => {
  const f = fixture();
  f.lease("2026-10-04T21:00:02.000Z");
  await f.authority(f.tx, f.input);
  f.clock("2026-10-04T21:00:02.000Z");
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("remaining Nutrition/field holder refusal cannot be replaced with empty defaults", async () => {
  const f = fixture();
  f.remaining.mockRejectedValue(new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"));
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toThrow();
});
it("swallowed reentry cannot preserve a valid earlier admission", async () => {
  const f = fixture();
  f.remaining.mockImplementationOnce(async () => {
    await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  });
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toThrow();
});
it("cannot use a finalized transaction to obtain another source proof", async () => {
  const f = fixture();
  await f.authority(f.tx, f.input);
  await f.commit();
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
});
it("unknown fields/getters do not run or reach owning SQL", async () => {
  const f = fixture(),
    getter = vi.fn(() => f.aggregate);
  await expect(
    f.authority(
      f.tx,
      Object.defineProperty({ ...f.input }, "aggregate", { get: getter, enumerable: true }),
    ),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.sql).toEqual([]);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("captures complete proposed content before the first registration await", async () => {
  const f = fixture(),
    value = JSON.parse(JSON.stringify(f.input)) as typeof f.input;
  vi.mocked(f.options.registerBeforeCommit).mockImplementationOnce(async (_tx, work, final) => {
    f.guards.push({ work, final });
    Object.assign(value.aggregate.draft.localizedNames, { "en-CA": "Changed during await" });
  });
  await f.authority(f.tx, value);
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ aggregate: f.aggregate }),
  );
  await f.commit();
});
it("swallowed registration reentry cannot acquire sources or preserve admission", async () => {
  const f = fixture();
  vi.mocked(f.options.registerBeforeCommit).mockImplementationOnce(async (_tx, work, final) => {
    f.guards.push({ work, final });
    await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  });
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  expect(f.sql).toEqual([]);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
