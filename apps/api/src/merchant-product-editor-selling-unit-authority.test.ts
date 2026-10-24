import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  catalogSellingUnitRegistryDigest,
  parseCatalogSellingUnitRegistry,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  sellingUnitRegistryFields,
} from "@rms/catalog";
import { createMerchantProductEditorSellingUnitAuthority as create } from "./merchant-product-editor-selling-unit-authority.js";
const sourceMock = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("@rms/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/catalog")>()),
  createPostgresSellingUnitRegistryStore: sourceMock.factory,
}));
const id = (n: number) => "019a2421-7000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-04T21:00:00.000Z",
  until = "2026-10-04T21:00:05.000Z";
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type Options = Parameters<typeof create>[0];
type Tx = Options["transaction"];
type SourceOptions = Parameters<
  typeof import("@rms/catalog").createPostgresSellingUnitRegistryStore
>[0];
function fixture(
  purpose: "CATALOG_PRODUCT_CREATE" | "CATALOG_PRODUCT_DRAFT_REPLACE" = "CATALOG_PRODUCT_CREATE",
  hasSku = true,
) {
  const state = {
    now: at,
    denied: false,
    remainingDenied: false,
    missing: false,
    malformed: false,
    callbackTwice: false,
    lease: until,
  };
  const guards: { work: () => Promise<void>; final: () => void }[] = [];
  const tx: Tx = { query: vi.fn(async () => ({ rows: [] })) as Tx["query"] };
  const aggregate = parseProductAggregate({
    productReference: id(6),
    brandReference: id(2),
    internalCode: "SYNTHETIC_PRODUCT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: purpose === "CATALOG_PRODUCT_CREATE" ? 1 : 3,
    createdAt: at,
    createdByActorReference: id(4),
    updatedAt: at,
    draft: {
      versionReference: id(8),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic product" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      optionBindings: [],
      skus: hasSku
        ? [
            {
              skuReference: id(9),
              productReference: id(6),
              brandReference: id(2),
              skuCode: "SYNTHETIC_SKU",
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic SKU" },
              variantSelections: [],
              unitOfSale: "SYNTHETIC",
              unitQuantity: "1.25",
              createdAt: at,
              createdByActorReference: id(4),
            },
          ]
        : [],
      editorContent: {
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
      },
    },
  });
  const registry = parseCatalogSellingUnitRegistry({
    profile: "CatalogSellingUnitRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(10),
    versionReference: id(11),
    registryVersion: 1,
    previousSnapshotDigest: null,
    registeredAt: at,
    defaultLocale: "en-CA",
    units: [
      {
        unitReference: id(12),
        code: "SYNTHETIC",
        semanticDefinition: "Synthetic package",
        quantityDecimalPlaces: 2,
        localizedNames: { "en-CA": "Synthetic unit" },
        lifecycle: "Active",
      },
    ],
  });
  const input = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    productReference: id(6),
    operationReference: id(7),
    purposeCode: purpose,
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.manage" as const,
    observedAt: at,
    validUntil: until,
    mode: "DraftWrite" as const,
    aggregate,
    requiredFields: productEditorContentFields,
    requiredReferenceChecks: productEditorContentReferenceChecks,
  };
  const currentAuthorization = {
    authorizeActions: vi.fn(async () => {
      if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    assertCurrent: vi.fn(() => {
      if (state.now >= state.lease) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    }),
    withCurrentStoreScope: vi.fn(),
  } as unknown as Options["currentAuthorization"];
  const remaining = vi.fn<Options["remainingAuthority"]>(async () => {
    if (state.remainingDenied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  const options: Options = {
    transaction: tx,
    ...input,
    clock: { now: () => state.now },
    originalValidUntil: until,
    currentAuthorization,
    remainingAuthority: remaining,
    registerBeforeCommit: async (actual, work, final) => {
      expect(actual).toBe(tx);
      if (final === undefined) throw new Error("Missing original final assertion");
      guards.push({ work, final });
    },
  };
  const observed: unknown[] = [];
  sourceMock.factory.mockImplementation((ports: SourceOptions) => ({
    async withRegisteredProductSkuQuantities(
      request: unknown,
      work: (proof: unknown, actual: Tx) => Promise<void>,
    ) {
      observed.push(request);
      if (state.missing) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      const hold = () =>
        ports.authority.holdUntilTransactionCompletes(tx, {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User",
          purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
          permission: "catalog.manage",
          action: "catalog.manage",
          mode: "Read",
          requiredPermissions: ["catalog.manage"],
          registry,
          requiredFields: sellingUnitRegistryFields,
          observedAt: ports.clock.now(),
        });
      await ports.registerBeforeCommit(tx, hold, () => {
        ports.clock.now();
      });
      await hold();
      const proof = {
        registry,
        snapshotDigest: catalogSellingUnitRegistryDigest(registry),
        sourceAuthority: state.malformed ? "Forged" : "CurrentTransactionHeld",
        request,
      };
      await work(proof, tx);
      if (state.callbackTwice) await work(proof, tx);
    },
  }));
  const authority = create(options);
  const commit = async () => {
    for (const guard of guards) await guard.work();
    for (const guard of guards) guard.final();
  };
  return {
    state,
    tx,
    input,
    authority,
    options,
    currentAuthorization,
    remaining,
    observed,
    guards,
    commit,
  };
}
beforeEach(() => sourceMock.factory.mockReset());
// Controlled source/IAM/remaining ports here; Catalog native/source tests own SQL,
// registration, RLS and real Audit/Outbox. This suite covers actual API composition.
it.each(["CATALOG_PRODUCT_CREATE", "CATALOG_PRODUCT_DRAFT_REPLACE"] as const)(
  "captures original %s proof and reholds actual IAM without querying after own write",
  async (purpose) => {
    const h = fixture(purpose);
    await h.authority(h.tx, h.input);
    await h.authority(h.tx, h.input);
    await h.commit();
    expect(h.observed).toHaveLength(1);
    expect(h.remaining).toHaveBeenCalledTimes(2);
    expect(h.currentAuthorization.authorizeActions).toHaveBeenCalledWith(["catalog.manage"]);
  },
);
it("actual zero SKU membership does not fabricate a registry or skip independent fields", async () => {
  const h = fixture("CATALOG_PRODUCT_CREATE", false);
  await h.authority(h.tx, h.input);
  await h.commit();
  expect(sourceMock.factory).not.toHaveBeenCalled();
  expect(h.remaining).toHaveBeenCalledOnce();
});
it("Read delegates original complete fields without treating unit source as recorded field authority", async () => {
  const h = fixture("CATALOG_PRODUCT_DRAFT_REPLACE");
  await h.authority(h.tx, { ...h.input, mode: "Read", requiredReferenceChecks: [] });
  await h.commit();
  expect(h.observed).toHaveLength(0);
  expect(h.remaining).toHaveBeenCalledOnce();
});
it("missing registration remains an actual business refusal", async () => {
  const h = fixture();
  h.state.missing = true;
  await expect(h.authority(h.tx, h.input)).rejects.toMatchObject({
    code: "CATALOG_LIFECYCLE_CONFLICT",
  });
  await expect(h.commit()).rejects.toMatchObject(unavailable);
});
it("own independent field source denial cannot be replaced by registered units", async () => {
  const h = fixture();
  h.state.remainingDenied = true;
  await expect(h.authority(h.tx, h.input)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  await expect(h.commit()).rejects.toMatchObject(unavailable);
});
it.each(["operationReference", "productReference", "sessionReference", "storeReference"] as const)(
  "changed %s poisons all later requests",
  async (key) => {
    const h = fixture();
    await h.authority(h.tx, h.input);
    await expect(h.authority(h.tx, { ...h.input, [key]: id(90) })).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    await expect(h.authority(h.tx, h.input)).rejects.toMatchObject(unavailable);
  },
);
it("changed candidate after own CAS cannot advance original source proof", async () => {
  const h = fixture("CATALOG_PRODUCT_DRAFT_REPLACE");
  await h.authority(h.tx, h.input);
  const aggregate = { ...h.input.aggregate, aggregateVersion: 4 };
  await expect(h.authority(h.tx, { ...h.input, aggregate })).rejects.toMatchObject(unavailable);
  expect(h.observed).toHaveLength(1);
});
it("original lease is not renewed by a changed observation tuple", async () => {
  const h = fixture();
  await h.authority(h.tx, h.input);
  h.state.now = "2026-10-04T21:00:00.001Z";
  await expect(
    h.authority(h.tx, {
      ...h.input,
      observedAt: h.state.now,
      validUntil: "2026-10-04T21:00:05.001Z",
    }),
  ).rejects.toMatchObject(unavailable);
});
it("late actual authorization loss stops final COMMIT", async () => {
  const h = fixture();
  await h.authority(h.tx, h.input);
  h.state.denied = true;
  await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("shortened real authorization lease is observed in synchronous final assertion", async () => {
  const h = fixture();
  await h.authority(h.tx, h.input);
  for (const guard of h.guards) await guard.work();
  h.state.lease = "2026-10-04T21:00:00.001Z";
  h.state.now = h.state.lease;
  const guard = h.guards[0];
  if (guard === undefined) throw new Error("Missing original guard");
  expect(() => guard.final()).toThrow();
});
it("query replacement and original deadline expiry reject borrowed transaction reuse", async () => {
  const h = fixture();
  await h.authority(h.tx, h.input);
  h.tx.query = vi.fn() as Tx["query"];
  await expect(h.commit()).rejects.toMatchObject(unavailable);
  const expired = fixture();
  expired.state.now = until;
  await expect(expired.authority(expired.tx, expired.input)).rejects.toMatchObject(unavailable);
});
it("source callback reentry and asserted fake sourceAuthority refuse", async () => {
  const h = fixture();
  h.state.callbackTwice = true;
  await expect(h.authority(h.tx, h.input)).rejects.toMatchObject(unavailable);
  const fake = fixture();
  fake.state.malformed = true;
  await expect(fake.authority(fake.tx, fake.input)).rejects.toMatchObject(unavailable);
});
it("swallowed nested invocation cannot revive remaining work or commit", async () => {
  const h = fixture();
  h.remaining.mockImplementation(async () => {
    await h.authority(h.tx, h.input).catch(() => undefined);
  });
  await expect(h.authority(h.tx, h.input)).rejects.toMatchObject(unavailable);
  await expect(h.commit()).rejects.toMatchObject(unavailable);
});
it("post COMMIT calls refuse while child original source clock can finalize", async () => {
  const h = fixture();
  await h.authority(h.tx, h.input);
  await h.commit();
  await expect(h.authority(h.tx, h.input)).rejects.toMatchObject(unavailable);
});
it("captures trusted remaining and bridge ports before source awaits", async () => {
  const h = fixture();
  Object.defineProperty(h.options, "remainingAuthority", {
    value: vi.fn(async () => {
      throw new Error("MUTATED");
    }),
  });
  await h.authority(h.tx, h.input);
  expect(h.remaining).toHaveBeenCalledOnce();
});

it("Create original receipt Read retains recorded units without reacquiring today's registry", async () => {
  const h = fixture("CATALOG_PRODUCT_CREATE");
  h.state.missing = true;
  await h.authority(h.tx, { ...h.input, mode: "Read", requiredReferenceChecks: [] });
  await h.commit();
  expect(sourceMock.factory).not.toHaveBeenCalled();
  expect(h.remaining).toHaveBeenCalledOnce();
  expect(h.currentAuthorization.authorizeActions).toHaveBeenCalledWith(["catalog.manage"]);
});
it("Create Read cannot admit a successor aggregate as the original receipt", async () => {
  const h = fixture("CATALOG_PRODUCT_CREATE");
  await expect(
    h.authority(h.tx, {
      ...h.input,
      mode: "Read",
      requiredReferenceChecks: [],
      aggregate: { ...h.input.aggregate, aggregateVersion: 2 },
    }),
  ).rejects.toMatchObject(unavailable);
  expect(h.remaining).not.toHaveBeenCalled();
  expect(sourceMock.factory).not.toHaveBeenCalled();
});
