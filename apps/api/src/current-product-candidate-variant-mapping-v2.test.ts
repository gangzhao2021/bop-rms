import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogInstant,
  parseProductAggregate,
  deriveCatalogProductPublicationContentIdentity,
  bindCatalogProductValidationCandidateV2,
  parseProductPublicationCommandV2,
  buildProductVariantIdentityHistory,
  type createPostgresProductVariantIdentityHistorySource,
} from "@rms/catalog";
import { createCurrentProductCandidateVariantMappingSourceV2 } from "./current-product-candidate-variant-mapping-v2.js";
type OwnerOptions = Parameters<typeof createPostgresProductVariantIdentityHistorySource>[0];
const owner = vi.hoisted(() => ({ mode: "normal", read: vi.fn() }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductVariantIdentityHistorySource: (options: OwnerOptions) => ({
    withCurrentSnapshot: async <T>(
      request: Parameters<
        ReturnType<typeof createPostgresProductVariantIdentityHistorySource>["withCurrentSnapshot"]
      >[0],
      work: (value: unknown) => Promise<T>,
    ) => {
      if (owner.mode === "skip") return undefined;
      return options.transactions.run(async (tx) => {
        const hold = () =>
          options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: options.tenantReference,
            brandReference: options.brandReference,
            actorReference: options.actorReference,
            purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY",
            permission: "catalog.product.history.read",
            request,
            requiredFields: [
              "productReference",
              "aggregateVersion",
              "sku.variantSelections",
              "editorContent.variantDimensions.identity",
              "editorContent.variantDimensions.code",
            ],
            observedAt: options.clock.now(),
          });
        await hold();
        const history = await owner.read(request, tx);
        const answer = await work(history);
        if (owner.mode === "repeat") {
          try {
            await work(history);
          } catch {
            /* owner swallowing remains refused */
          }
        }
        await hold();
        return owner.mode === "substitute" ? { value: "substitute" } : answer;
      });
    },
  }),
}));
const id = (n: number) => `019a2421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-30T03:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
beforeEach(() => {
  owner.mode = "normal";
  owner.read.mockReset();
});
function aggregate(full = true) {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "VARIANT_HISTORY",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic" },
          variantSelections: [{ dimensionReference: id(6), valueReference: id(7) }],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings: [],
      ...(full
        ? {
            editorContent: {
              profile: "CatalogProductEditorContentV1",
              localizedShortDescriptions: {},
              localizedDescriptions: { "en-CA": "Private synthetic note omitted from source" },
              preparationNotes: {},
              tagReferences: [],
              attributeValues: [],
              media: [],
              variantDimensions: [
                {
                  dimensionReference: id(6),
                  code: "SIZE",
                  localizedNames: { "en-CA": "Size" },
                  sortOrder: 0,
                  selectionRequirement: "Required",
                  values: [
                    {
                      valueReference: id(7),
                      code: "SMALL",
                      localizedNames: { "en-CA": "Small" },
                      sortOrder: 0,
                      attributeReference: null,
                      mediaReference: null,
                    },
                  ],
                },
              ],
              variantCombinations: [
                {
                  selections: [{ dimensionReference: id(6), valueReference: id(7) }],
                  disposition: "Valid",
                  skuReference: id(5),
                },
              ],
              optionRules: [],
              allergenReferences: [],
              nutritionProfile: null,
            },
          }
        : {}),
    },
  });
}

function fixture(kind: "normal" | "unmapped" | "changed" | "empty" = "normal") {
  const before = aggregate(),
    changed = structuredClone(before);
  if (kind === "unmapped") {
    Object.assign(changed.draft, { skus: [] });
    Object.assign(changed.draft.editorContent?.variantCombinations[0] ?? {}, {
      disposition: "NotGenerated",
      skuReference: null,
    });
  }
  if (kind === "changed")
    Object.assign(changed.draft.editorContent?.variantDimensions[0] ?? {}, { code: "REUSED_CODE" });
  if (kind === "empty") {
    Object.assign(changed.draft, { skus: [] });
    Object.assign(changed.draft.editorContent ?? {}, {
      variantDimensions: [],
      variantCombinations: [],
    });
  }
  const current = parseProductAggregate(changed),
    identity = deriveCatalogProductPublicationContentIdentity(current),
    noReplacement = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    replacementIntent = { ...noReplacement, digest: hash(noReplacement) },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(11),
      productReference: id(1),
      versionReference: id(4),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(12), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(at), effectiveUntil: null },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "VALIDATE",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    }),
    candidate = {
      ...bindCatalogProductValidationCandidateV2(command, current, at),
      internalCodeCheck: { code: "InternalCode" as const, outcome: "Pass" as const },
    },
    historical = kind === "empty" ? current : before,
    history = buildProductVariantIdentityHistory(
      {
        aggregateVersion: 1,
        observedAt: at,
        history: [
          {
            aggregate: historical,
            operationReference: id(20),
            snapshotDigest: hash(historical),
            coherent: true,
          },
        ],
      },
      id(2),
      { productReference: id(1), expectedAggregateVersion: 1, originalIntentDigest: hash(command) },
    );
  let clock = at;
  const tx = { query: vi.fn() },
    hold = vi.fn(async () => undefined),
    authority = { holdUntilTransactionCompletes: hold },
    source = createCurrentProductCandidateVariantMappingSourceV2({
      authority,
      clock: { now: () => clock },
    });
  owner.read.mockImplementation(async (request, actual) => {
    expect(request).toEqual({
      productReference: id(1),
      expectedAggregateVersion: 1,
      originalIntentDigest: hash(command),
    });
    expect(actual).toBe(tx);
    return history;
  });
  const run = (work = async (value: unknown) => value) =>
    source.withHeldCandidateAssessment(tx, command, candidate, work);
  return {
    command,
    candidate,
    history,
    source,
    tx,
    hold,
    authority,
    run,
    setClock: (value: string) => {
      clock = value;
    },
  };
}
it("derives explicit mapping from the complete candidate and held permanent identity history", async () => {
  const f = fixture(),
    value = await f.source.withHeldCandidateAssessment(
      f.tx,
      f.command,
      f.candidate,
      async (value) => value,
    );
  expect(value.check).toEqual({ code: "VariantMapping", outcome: "Pass" });
  expect(value.originalIntentDigest).toBe(hash(f.command));
  expect(value.validUntil).toBe("2026-09-30T03:00:05.000Z");
  expect(f.hold).toHaveBeenCalledTimes(2);
});
it.each(["unmapped", "changed"] as const)(
  "returns a real HardError for %s definitions",
  async (kind) => {
    const f = fixture(kind),
      value = await f.source.withHeldCandidateAssessment(
        f.tx,
        f.command,
        f.candidate,
        async (value) => value,
      );
    expect(value.check.outcome).toBe("HardError");
  },
);
it("allows no Variant definition without manufacturing SKU readiness", async () => {
  const f = fixture("empty"),
    value = await f.run();
  expect(value).toMatchObject({ check: { code: "VariantMapping", outcome: "Pass" } });
  expect(value).not.toHaveProperty("skuCheck");
});
it.each(["skip", "repeat", "substitute"])("refuses %s owning callbacks", async (mode) => {
  const f = fixture();
  owner.mode = mode;
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["digest", "scope", "intent", "future"])(
  "refuses corrupt or unbound %s history before work",
  async (kind) => {
    const f = fixture(),
      h = { ...f.history };
    if (kind === "digest") h.digest = hash("forged");
    if (kind === "scope") h.brandReference = id(98);
    if (kind === "intent") h.originalIntentDigest = hash("another full command");
    if (kind === "future") h.observedAt = "2026-09-30T03:00:00.001Z";
    if (kind !== "digest") {
      h.digest = hash(Object.fromEntries(Object.entries(h).filter(([key]) => key !== "digest")));
    }
    owner.read.mockResolvedValue(h);
    const consumer = vi.fn();
    await expect(f.run(consumer)).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(consumer).not.toHaveBeenCalled();
  },
);
it.each(["2026-09-30T03:00:05.000Z", "2026-09-30T02:59:59.999Z"])(
  "refuses clock %s after consumer and poisons reuse",
  async (clock) => {
    const f = fixture();
    await expect(
      f.run(async () => {
        f.setClock(clock);
        return true;
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    f.setClock(at);
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("retains the shorter original candidate lease", async () => {
  const f = fixture();
  f.candidate.validUntil = parseCatalogInstant("2026-09-30T03:00:01.000Z");
  const value = await f.run();
  expect(value).toMatchObject({ validUntil: f.candidate.validUntil });
});
it("captures authority receiver and preserves late permission denial", async () => {
  const f = fixture();
  f.authority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw new Error("replaced");
  });
  f.hold
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.authority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
});
it("refuses candidate tampering before reading history", async () => {
  const f = fixture();
  const altered = { ...f.candidate, originalIntentDigest: hash("different") };
  await expect(
    f.source.withHeldCandidateAssessment(f.tx, f.command, altered, async (v) => v),
  ).rejects.toThrow();
  expect(owner.read).not.toHaveBeenCalled();
});
