import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "@rms/catalog";
import { createMerchantProductPublicationContentAuthorityV2 } from "./merchant-product-publication-content-authority-v2.js";
const id = (n: number) => `019a2444-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const noneBody = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
const replacementIntent = {
  ...noneBody,
  digest: "sha256:" + sha256Hex(canonicalizeRfc8785(noneBody)),
};
const v2 = {
  profile: "CatalogProductPublicationCommandV2",
  replacementIntent,
  replacementIntentDigest: replacementIntent.digest,
};
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
type Options = Parameters<typeof createMerchantProductPublicationContentAuthorityV2>[0];
function setup() {
  let clock = at;
  const checks: (() => Promise<void>)[] = [];
  const finalAssertions: (() => void)[] = [];
  const action = vi.fn(async (action: string) => ({ effect: "Allow", scopeKind: "Brand", action }));
  const authority = vi.fn<Options["authority"]>(async () => undefined);
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const options: Options = {
    transaction: tx,
    scope: {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
      actorReference: id(4),
      authorizeAction: action,
    } as never,
    sessionReference: id(6),
    command: parseProductPublicationCommandV2({
      ...v2,
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      productReference: id(5),
      versionReference: id(10),
      operationReference: id(7),
      action: "Validate",
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      contentDigest: "sha256:" + "a".repeat(64),
      configurationDigest: "sha256:" + "b".repeat(64),
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
    }),
    authority,
    now: () => clock,
    registerBeforeCommit: async (actual, check, finalAssert) => {
      expect(actual).toBe(tx);
      checks.push(check);
      if (finalAssert) finalAssertions.push(finalAssert);
    },
  };
  const guard = createMerchantProductPublicationContentAuthorityV2(options);
  const request = (mode: "Read" | "Publish" = "Read", root = aggregate) => ({
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
    finalAssertions,
    request,
    clock: (value: string) => {
      clock = value;
    },
    hold: (mode: "Read" | "Publish" = "Read", root = aggregate) =>
      guard.holdUntilTransactionCompletes(tx, request(mode, root)),
    finish: async () => {
      for (const check of checks) await check();
      for (const assert of finalAssertions) expect(assert()).toBeUndefined();
    },
  };
}
it("binds independent complete authority to server scope/purpose and original read/write snapshots", async () => {
  const f = setup();
  await f.hold();
  await f.hold("Publish", parseProductAggregate({ ...aggregate, aggregateVersion: 2 }));
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
    command: parseProductPublicationCommandV2({
      ...v2,
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      productReference: id(5),
      versionReference: id(10),
      operationReference: id(7),
      action: "Validate",
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      contentDigest: "sha256:" + "a".repeat(64),
      configurationDigest: "sha256:" + "b".repeat(64),
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
    }),
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    permission: "catalog.manage",
    owningAction: "catalog.product.read",
    observedAt: at,
    validUntil: "2026-09-30T23:00:05.000Z",
    mode: "Publish",
    requiredReferenceChecks: productEditorContentReferenceChecks,
  });
  expect(Object.isFrozen(call?.[1])).toBe(true);
  expect(call?.[1].replacementIntentDigest).toBe(replacementIntent.digest);
  expect(call?.[1].originalIntentDigest).toBe(
    "sha256:" + sha256Hex(canonicalizeRfc8785(f.options.command)),
  );
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("retains content's original lease after a later awaited commit guard", async () => {
  const f = setup();
  await f.hold();
  expect(f.finalAssertions).toHaveLength(1);
  f.checks.push(async () => {
    await Promise.resolve();
    f.clock("2026-09-30T23:00:05.000Z");
  });
  await expect(f.finish()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.authority).toHaveBeenCalledTimes(2);
});
it.each(["catalog.manage", "catalog.product.read", "catalog.sku.read"])(
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
  await expect(f.hold("Publish")).rejects.toMatchObject({
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
      ...f.request("Publish"),
      ...(kind === "fields" ? { requiredFields: [] } : {}),
      ...(kind === "references" ? { requiredReferenceChecks: [] } : {}),
      ...(kind === "mode" ? { mode: "DraftWrite" } : {}),
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

it("retains Read of successor/conflicting/original snapshots without Publish reference acquisition", async () => {
  const f = setup();
  await f.hold(
    "Read",
    parseProductAggregate({
      ...aggregate,
      aggregateVersion: 99,
      draft: { ...aggregate.draft, versionReference: id(11) },
    }),
  );
  await f.finish();
  expect(
    f.authority.mock.calls.every(
      ([, input]) => input.mode === "Read" && input.requiredReferenceChecks.length === 0,
    ),
  ).toBe(true);
  expect(f.authority.mock.calls[0]?.[1].command.operationReference).toBe(id(7));
});
it("rejects nonvoid holder and changed query identity", async () => {
  const f = setup();
  f.authority.mockResolvedValue({} as never);
  await expect(f.hold()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  const g = setup();
  await g.hold();
  g.tx.query = vi.fn(async () => ({ rows: [] }));
  await expect(g.finish()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("retains monotonic observation even within original deadline", async () => {
  const f = setup();
  await f.hold();
  f.clock("2026-09-30T23:00:03.000Z");
  await f.hold();
  f.clock("2026-09-30T23:00:02.000Z");
  await expect(f.finish()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("refuses descriptor accessors before invoking independent holder", async () => {
  const f = setup(),
    get = vi.fn(() => "Read");
  const request = Object.defineProperty({ ...f.request() }, "mode", { get, enumerable: true });
  await expect(f.guard.holdUntilTransactionCompletes(f.tx, request)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(get).not.toHaveBeenCalled();
  expect(f.authority).not.toHaveBeenCalled();
});
it("detects native withdrawal during awaited independent source hold", async () => {
  const f = setup();
  f.authority.mockImplementation(async () => {
    f.action.mockImplementation(async (action) => ({ effect: "Deny", scopeKind: "Brand", action }));
  });
  await expect(f.hold("Publish")).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
});
