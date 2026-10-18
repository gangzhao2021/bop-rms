import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "@rms/catalog";
import { createMerchantProductEditorContentAuthority } from "./merchant-product-editor-content-authority.js";
const id = (n: number) => `019a2444-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-30T23:00:00.000Z";
const content = {
  profile: "CatalogProductEditorContentV1",
  localizedShortDescriptions: {},
  localizedDescriptions: {},
  preparationNotes: {},
  tagReferences: [],
  attributeValues: [],
  media: [],
  variantDimensions: [],
  variantCombinations: [],
  optionRules: [],
  allergenReferences: [],
  nutritionProfile: null,
};
const aggregate = parseProductAggregate({
  productReference: id(5),
  brandReference: id(2),
  internalCode: "SYNTHETIC",
  productType: "PreparedFood",
  lifecycle: "Draft",
  aggregateVersion: 1,
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
    createdAt: at,
    updatedAt: at,
    skus: [],
    optionBindings: [],
    editorContent: content,
  },
});
type Options = Parameters<typeof createMerchantProductEditorContentAuthority>[0];
function setup(purposeCode?: Options["purposeCode"]) {
  let clock = at;
  const checks: (() => Promise<void>)[] = [];
  const action = vi.fn(async (action: string) => ({ effect: "Allow", scopeKind: "Brand", action }));
  const authority = vi.fn<Options["authority"]>(async () => undefined);
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const options: Options = {
    ...(purposeCode === undefined ? {} : { purposeCode }),
    transaction: tx,
    scope: {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
      actorReference: id(4),
      authorizeAction: action,
    } as never,
    sessionReference: id(6),
    productReference: id(5),
    operationReference: id(7),
    authority,
    now: () => clock,
    registerBeforeCommit: async (actual, check) => {
      expect(actual).toBe(tx);
      checks.push(check);
    },
  };
  const guard = createMerchantProductEditorContentAuthority(options);
  const request = (mode: "Read" | "DraftWrite" = "Read", root = aggregate) => ({
    mode,
    aggregate: root,
    requiredFields: productEditorContentFields,
    requiredReferenceChecks: mode === "Read" ? [] : productEditorContentReferenceChecks,
  });
  return {
    options,
    guard,
    tx,
    authority,
    action,
    checks,
    request,
    clock: (value: string) => {
      clock = value;
    },
    hold: (mode: "Read" | "DraftWrite" = "Read", root = aggregate) =>
      guard.holdUntilTransactionCompletes(tx, request(mode, root)),
    finish: async () => {
      for (const check of checks) await check();
    },
  };
}
it("holds the distinct initial Create purpose through COMMIT and refuses noninitial aggregates", async () => {
  const f = setup("CATALOG_PRODUCT_CREATE");
  await f.hold("DraftWrite");
  await f.finish();
  expect(f.authority.mock.calls[0]?.[1].purposeCode).toBe("CATALOG_PRODUCT_CREATE");
  await expect(
    f.hold("DraftWrite", parseProductAggregate({ ...aggregate, aggregateVersion: 2 })),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("binds independent complete authority to server scope/purpose and original read/write snapshots", async () => {
  const f = setup();
  await f.hold();
  await f.hold("DraftWrite", parseProductAggregate({ ...aggregate, aggregateVersion: 2 }));
  await f.hold();
  expect(f.checks).toHaveLength(1);
  await f.finish();
  expect(f.authority).toHaveBeenCalledTimes(5);
  const call = f.authority.mock.calls[1];
  expect(call?.[0]).toBe(f.tx);
  expect(call?.[1]).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(6),
    productReference: id(5),
    operationReference: id(7),
    purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE",
    permission: "catalog.manage",
    owningAction: "catalog.product.manage",
    observedAt: at,
    validUntil: "2026-09-30T23:00:05.000Z",
    mode: "DraftWrite",
    requiredReferenceChecks: productEditorContentReferenceChecks,
  });
  expect(Object.isFrozen(call?.[1])).toBe(true);
  expect(f.tx.query).not.toHaveBeenCalled();
});
it.each(["catalog.product.read", "catalog.sku.read"])(
  "requires independent current %s through final check",
  async (denied) => {
    const f = setup();
    await f.hold();
    f.action.mockImplementation(async (action) => ({
      effect: action === denied ? "Deny" : "Allow",
      scopeKind: "Brand",
      action,
    }));
    await expect(f.finish()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  },
);
it.each(["Deny", "Hide", "Unknown"])(
  "refuses %s read decision before full content holder",
  async (effect) => {
    const f = setup();
    f.action.mockResolvedValue({ effect, scopeKind: "Brand", action: "catalog.product.read" });
    await expect(f.hold()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.authority).not.toHaveBeenCalled();
  },
);
it("refuses Store read grants", async () => {
  const f = setup();
  f.action.mockImplementation(async (action) => ({ effect: "Allow", scopeKind: "Store", action }));
  await expect(f.hold()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it.each(["2026-09-30T22:59:59.999Z", "2026-09-30T23:00:05.000Z"])(
  "refuses backwards/exclusive clock %s without renewal",
  async (at) => {
    const f = setup();
    await f.hold();
    f.clock(at);
    await expect(f.finish()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("detects expiry while current holder is awaited", async () => {
  const f = setup();
  f.authority.mockImplementation(async () => {
    f.clock("2026-09-30T23:00:05.000Z");
  });
  await expect(f.hold()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("late complete-field withdrawal poisons further calls", async () => {
  const f = setup();
  await f.hold();
  f.authority.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.finish()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  f.authority.mockResolvedValue(undefined);
  await expect(f.hold()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("cannot swallow an initial missing reference source and finish a prior admitted read", async () => {
  const f = setup();
  await f.hold();
  f.authority.mockRejectedValueOnce(Error("SYNTHETIC_PRIVATE_SOURCE_FAILURE"));
  await expect(f.hold("DraftWrite")).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  await expect(f.finish()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captures original configured holder, clock and scope action methods", async () => {
  const f = setup();
  Object.assign(f.options, {
    transaction: {
      query: vi.fn(async () => {
        throw Error("SYNTHETIC_REBOUND");
      }),
    },
    authority: async () => {
      throw Error("SYNTHETIC_REBOUND");
    },
    now: () => "invalid",
  });
  Object.assign(f.options.scope, {
    authorizeAction: async () => {
      throw Error("SYNTHETIC_REBOUND");
    },
  });
  await f.hold();
  await f.finish();
  expect(f.authority).toHaveBeenCalledTimes(2);
});
it.each(["brandReference", "productReference"] as const)(
  "rejects foreign owning %s",
  async (key) => {
    const f = setup();
    await expect(
      f.hold("Read", parseProductAggregate({ ...aggregate, [key]: id(99) })),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each(["fields", "references", "mode", "transaction"])(
  "rejects rebound owning %s contract",
  async (kind) => {
    const f = setup();
    const request = {
      ...f.request("DraftWrite"),
      ...(kind === "fields" ? { requiredFields: [] } : {}),
      ...(kind === "references" ? { requiredReferenceChecks: [] } : {}),
      ...(kind === "mode" ? { mode: "Publish" } : {}),
    };
    await expect(
      f.guard.holdUntilTransactionCompletes(
        kind === "transaction" ? { ...f.tx } : f.tx,
        request as never,
      ),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.authority).not.toHaveBeenCalled();
  },
);
it("requires complete content and bounds retained owning snapshots", async () => {
  const f = setup();
  const { editorContent, ...legacy } = aggregate.draft;
  void editorContent;
  await expect(
    f.hold("Read", parseProductAggregate({ ...aggregate, draft: legacy })),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  const bounded = setup();
  for (let version = 1; version <= 16; version++)
    await bounded.hold("Read", parseProductAggregate({ ...aggregate, aggregateVersion: version }));
  await expect(
    bounded.hold("Read", parseProductAggregate({ ...aggregate, aggregateVersion: 17 })),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("post-COMMIT presentation expiry refuses content without a rollback assertion", async () => {
  const f = setup();
  await f.hold();
  await f.finish();
  f.clock("2026-09-30T23:00:05.000Z");
  expect(() => f.guard.assertCurrent()).toThrowError(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
