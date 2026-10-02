import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate, productEditorContentFields } from "@rms/catalog";
import { remainingProductEditorReferenceChecks } from "./merchant-product-editor-registered-content-authority.js";
import {
  createMerchantProductEditorVariantContentAuthority as create,
  remainingProductEditorVariantReferenceChecks,
} from "./merchant-product-editor-variant-content-authority.js";
const id = (n: number) => `019a2446-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-30T23:55:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type Options = Parameters<typeof create>[0];
function candidate(full = true) {
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

function fixture() {
  let clock = at,
    actualRoot = 1,
    sourceAt = at,
    coherent = true;
  const original = candidate();
  const next = (root: number) =>
    parseProductAggregate({
      ...original,
      aggregateVersion: root,
      draft: { ...original.draft, localizedNames: { "en-CA": "Synthetic root " + root } },
    });
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("jsonb_build_object('aggregateVersion'")) {
      if (values[2] !== actualRoot) return { rows: [] };
      return {
        rows: [
          {
            source: {
              aggregateVersion: actualRoot,
              observedAt: sourceAt,
              history: Array.from({ length: actualRoot }, (_, i) => {
                const aggregate = i === 0 ? original : next(i + 1);
                return {
                  aggregate,
                  operationReference: id(100 + i),
                  snapshotDigest: hash(aggregate),
                  coherent,
                };
              }),
            },
          },
        ],
      };
    }
    return { rows: [] };
  });
  const tx = { query } as unknown as Parameters<ReturnType<typeof create>>[0];
  const variantHold = vi.fn<Options["variantAuthority"]["holdUntilTransactionCompletes"]>(
    async () => undefined,
  );
  const remaining = vi.fn<Options["remainingAuthority"]>(async () => undefined);
  const options: Options = {
    variantAuthority: { holdUntilTransactionCompletes: variantHold },
    remainingAuthority: remaining,
    clock: { now: () => clock },
  };
  const authority = create(options);
  const base = {
    tenantReference: id(10),
    brandReference: id(2),
    storeReference: id(11),
    actorReference: id(3),
    sessionReference: id(12),
    productReference: id(1),
    operationReference: id(13),
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.manage" as const,
    purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
    observedAt: at,
    validUntil: "2026-09-30T23:55:05.000Z",
    requiredFields: productEditorContentFields,
  };
  const read = (aggregate = original) => ({
    ...base,
    mode: "Read" as const,
    aggregate,
    requiredReferenceChecks: [],
  });
  const write = (aggregate = next(2)) => ({
    ...base,
    mode: "DraftWrite" as const,
    aggregate,
    requiredReferenceChecks: remainingProductEditorReferenceChecks,
  });
  return {
    authority,
    options,
    original,
    next,
    tx,
    query,
    variantHold,
    remaining,
    base,
    read,
    write,
    clock: (v: string) => {
      clock = v;
    },
    root: (v: number) => {
      actualRoot = v;
    },
    sourceAt: (v: string) => {
      sourceAt = v;
    },
    coherent: (v: boolean) => {
      coherent = v;
    },
  };
}
it("reads admit only a root selector after current fields, never supplied history or qualification", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  expect(f.query).not.toHaveBeenCalled();
  expect(f.variantHold).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ mode: "Read", requiredReferenceChecks: [], aggregate: f.original }),
  );
});
it("prospective Draft uses actual current owner history and retains five mandatory checks", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  await f.authority(f.tx, f.write());
  expect(f.variantHold).toHaveBeenCalledTimes(3);
  expect(f.variantHold).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY",
      permission: "catalog.product.history.read",
      request: expect.objectContaining({ productReference: id(1), expectedAggregateVersion: 1 }),
    }),
  );
  expect(f.remaining).toHaveBeenLastCalledWith(
    f.tx,
    expect.objectContaining({
      mode: "DraftWrite",
      requiredReferenceChecks: remainingProductEditorVariantReferenceChecks,
    }),
  );
  expect(remainingProductEditorVariantReferenceChecks).toEqual([
    "BrandContentPolicy",
    "Media",
    "OptionSet",
    "SafetyVocabulary",
    "Nutrition",
  ]);
  expect(
    f.query.mock.calls.every(([sql]) => !/COMMIT|ROLLBACK|BEGIN|INSERT|UPDATE/.test(sql)),
  ).toBe(true);
});
it("post-write owning Read advances selector, while historical Read cannot lower it", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  await f.authority(f.tx, f.write());
  f.root(2);
  await f.authority(f.tx, f.read(f.next(2)));
  await f.authority(f.tx, f.read());
  await f.authority(f.tx, f.write());
  expect(f.variantHold).toHaveBeenLastCalledWith(
    f.tx,
    expect.objectContaining({ request: expect.objectContaining({ expectedAggregateVersion: 2 }) }),
  );
});
it("never guesses a predecessor when no admitted owning Read exists", async () => {
  const f = fixture();
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(f.query).not.toHaveBeenCalled();
  expect(f.remaining).not.toHaveBeenCalled();
});
it("rejects a gapped candidate without acquiring invented history", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  await expect(f.authority(f.tx, f.write(f.next(4)))).rejects.toMatchObject(unavailable);
  expect(f.query).not.toHaveBeenCalled();
});
it.each([
  "operationReference",
  "sessionReference",
  "storeReference",
  "actorReference",
  "tenantReference",
])("selector cannot cross changed %s", async (key) => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  await expect(f.authority(f.tx, { ...f.write(), [key]: id(99) })).rejects.toMatchObject(
    unavailable,
  );
  expect(f.query).not.toHaveBeenCalled();
});
it("actual owner current-root fence refuses an obsolete selector", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  f.root(2);
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(f.remaining).toHaveBeenCalledOnce();
});
it.each(["dimension", "value"])("owning used %s code cannot be reused", async (kind) => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  const candidate = f.next(2),
    content = candidate.draft.editorContent;
  if (!content) throw new Error("Missing synthetic content");
  const changed = parseProductAggregate({
    ...candidate,
    draft: {
      ...candidate.draft,
      editorContent: {
        ...content,
        variantDimensions: content.variantDimensions.map((d) => ({
          ...d,
          code: kind === "dimension" ? "OTHER" : d.code,
          values: d.values.map((v) => ({ ...v, code: kind === "value" ? "OTHER" : v.code })),
        })),
      },
    },
  });
  await expect(f.authority(f.tx, f.write(changed))).rejects.toMatchObject(unavailable);
  expect(f.remaining).toHaveBeenCalledOnce();
});
it("historically used dimensions survive removal of current SKU selections", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  const candidate = f.next(2);
  const changed = parseProductAggregate({
    ...candidate,
    draft: {
      ...candidate.draft,
      skus: [],
      editorContent: {
        ...candidate.draft.editorContent,
        variantDimensions: [],
        variantCombinations: [],
      },
    },
  });
  await expect(f.authority(f.tx, f.write(changed))).rejects.toMatchObject(unavailable);
});
it("incoherent committed owner receipts fail before remaining acceptance", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  f.coherent(false);
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(f.remaining).toHaveBeenCalledOnce();
});
it("old history observations cannot renew the original request", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  f.sourceAt("2026-09-30T23:54:59.999Z");
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});
it.each(["2026-09-30T23:54:59.999Z", "2026-09-30T23:55:05.000Z"])(
  "retains original exclusive clock %s",
  async (clock) => {
    const f = fixture();
    await f.authority(f.tx, f.read());
    f.clock(clock);
    await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it("late current history denial poisons all later reuse of the caller transaction", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  f.variantHold.mockImplementation(async () => {
    if (f.variantHold.mock.calls.length === 3) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  f.variantHold.mockResolvedValue(undefined);
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
});
it("unknown history holder result refuses before SQL", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  f.variantHold.mockResolvedValue("Allowed" as never);
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(f.query).not.toHaveBeenCalled();
});
it("remaining fields cannot return an unknown decision or expire before admission", async () => {
  const f = fixture();
  f.remaining.mockResolvedValue("Allowed" as never);
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
  const g = fixture();
  g.remaining.mockImplementation(async () => {
    g.clock(g.base.validUntil);
  });
  await expect(g.authority(g.tx, g.read())).rejects.toMatchObject(unavailable);
});
it.each(["variantAuthority", "remainingAuthority", "clock"])(
  "missing %s configuration refuses",
  (key) => {
    const f = fixture();
    expect(() => create({ ...f.options, [key]: undefined } as never)).toThrow(CatalogError);
  },
);
it("supplied history, getters or missing required checks never supply authority", async () => {
  const f = fixture(),
    get = vi.fn(() => f.original);
  await expect(f.authority(f.tx, { ...f.read(), history: [] } as never)).rejects.toMatchObject(
    unavailable,
  );
  const g = fixture();
  await expect(
    g.authority(g.tx, {
      ...g.read(),
      get aggregate() {
        return get();
      },
    }),
  ).rejects.toThrow(CatalogError);
  expect(get).not.toHaveBeenCalled();
  expect(g.query).not.toHaveBeenCalled();
});
it("captures history and clock collaborators before method rebound", async () => {
  const f = fixture();
  f.options.variantAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("Synthetic rebound");
  };
  f.options.clock.now = () => f.base.validUntil;
  await f.authority(f.tx, f.read());
  await expect(f.authority(f.tx, f.write())).resolves.toBeUndefined();
  expect(f.variantHold).toHaveBeenCalledTimes(3);
});
it("bounds sixteen lease selectors and never retains complete history or raw content", async () => {
  const f = fixture();
  for (let i = 0; i < 16; i++)
    await f.authority(f.tx, { ...f.read(), operationReference: id(200 + i) });
  await expect(
    f.authority(f.tx, { ...f.read(), operationReference: id(300) }),
  ).rejects.toMatchObject(unavailable);
  expect(f.remaining).toHaveBeenCalledTimes(16);
  expect(f.query).not.toHaveBeenCalled();
});
it("read recovery does not resolve old stored references into current history eligibility", async () => {
  const f = fixture();
  f.root(2);
  await expect(f.authority(f.tx, f.read())).resolves.toBeUndefined();
  expect(f.query).not.toHaveBeenCalled();
});

it.each(["conflict", "late-denial", "late-expiry", "unknown"])(
  "remaining content %s resolves only after owning final holds",
  async (mode) => {
    const f = fixture();
    await f.authority(f.tx, f.read());
    f.remaining.mockImplementation(async (_tx, input) => {
      if (input.mode !== "DraftWrite") return;
      if (mode === "late-expiry") f.clock(f.base.validUntil);
      if (mode === "unknown") throw new Error("SYNTHETIC_UNKNOWN_REMAINING_FAILURE");
      throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    });
    f.variantHold.mockImplementation(async () => {
      if (mode === "late-denial" && f.variantHold.mock.calls.length === 3)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
    await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
      code:
        mode === "conflict"
          ? "CATALOG_LIFECYCLE_CONFLICT"
          : mode === "late-denial"
            ? "CATALOG_PERMISSION_DENIED"
            : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.variantHold).toHaveBeenCalledTimes(
      mode === "unknown" || mode === "late-expiry" ? 2 : 3,
    );
    f.variantHold.mockResolvedValue(undefined);
    f.remaining.mockResolvedValue(undefined);
    f.clock(at);
    await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
  },
);
