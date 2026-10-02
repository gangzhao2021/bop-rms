import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { buildInventoryConfigurationReferenceSnapshot } from "@rms/inventory";
import { createCurrentProductRecipeIngredientReferenceSource as create } from "./current-product-recipe-ingredient-references.js";
const protocol = vi.hoisted(() => ({ parent: vi.fn(), inventory: vi.fn() }));
vi.mock("./current-product-published-recipe-content.js", () => ({
  createCurrentProductPublishedRecipeContentSource: () => ({ withCurrentContent: protocol.parent }),
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresInventoryConfigurationReferenceSourceStore: protocol.inventory,
}));
const id = (n: number) => `01902418-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(4),
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function raw(inactive = false) {
  const scope = { tenantReference: id(4), brandReference: id(1) };
  return {
    generation: "9",
    observedAt: at,
    counts: { items: "1", versions: "2", operations: "2" },
    items: [
      { ...scope, itemReference: id(10), itemType: "RawMaterial", createdAt: at, precise: true },
    ],
    versions: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      itemType: "RawMaterial",
      lifecycle: v === 2 && !inactive ? "Active" : "Inactive",
      recordedAt: at,
      precise: true,
    })),
    operations: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      operationReference: id(v === 1 ? 31 : 32),
      action: v === 1 ? "Create" : inactive ? "Deactivate" : "Activate",
    })),
  };
}

let clock = at,
  denied = false,
  changed = false,
  repeated = false,
  substitute = false,
  parentLate = false,
  outerExpiry = false,
  stale = false,
  subrecipe = false,
  onlySub = false;
const until = "2026-09-29T12:00:05.000Z";
const tx = { query: vi.fn(async () => ({ rows: [] })) };
function parentContent() {
  const ingredients = [
    {
      sourceKind: onlySub ? "SubRecipe" : "InventoryItem",
      requirementReference: id(51),
      sourceReference: id(10),
      sourceVersionReference: stale ? id(31) : id(32),
    },
  ];
  if (subrecipe)
    ingredients.push({
      sourceKind: "SubRecipe",
      requirementReference: id(52),
      sourceReference: id(12),
      sourceVersionReference: id(13),
    });
  return {
    validUntil: until,
    selection: { originalObservedAt: at },
    recipeContents: {
      request: { operationReference: request.operationReference, catalogIntentDigest: digest },
      activationAt: "2026-09-30T00:00:00.000Z",
      contents: [{ snapshot: { recipeReference: id(20), versionReference: id(21), ingredients } }],
    },
  };
}
function options() {
  return {
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(2),
    clock: { now: () => clock },
    catalogAuthority: {
      async holdUntilTransactionCompletes() {
        return;
      },
    },
    recipeAuthority: {
      async holdUntilTransactionCompletes() {
        return;
      },
    },
    storeAuthority: {
      async withCurrentBrandReferenceRead<T>(_r: unknown, w: () => Promise<T>) {
        return w();
      },
      async isCurrent() {
        return true;
      },
    },
    brandAuthority: {
      async withCurrentContentRead<T>(_r: unknown, _f: unknown, w: () => Promise<T>) {
        return w();
      },
      async isCurrent() {
        return true;
      },
    },
    contentAuthority: {
      async holdUntilTransactionCompletes() {
        return;
      },
    },
    inventoryAuthority: {
      async holdUntilTransactionCompletes(actual: unknown, fields: unknown) {
        expect(actual).toBe(tx);
        expect(fields).toMatchObject({ tenantReference: id(4) });
        if (denied) throw new Error("synthetic fields denial");
      },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  clock = at;
  denied = false;
  changed = false;
  repeated = false;
  substitute = false;
  parentLate = false;
  outerExpiry = false;
  stale = false;
  subrecipe = false;
  onlySub = false;
  protocol.parent.mockImplementation(async (actual, value, work) => {
    expect(actual).toBe(tx);
    expect(value).toEqual({ original: "selector" });
    const result = await work(parentContent());
    if (parentLate) throw new Error("synthetic outer final change");
    if (outerExpiry) clock = until;
    return result;
  });
  protocol.inventory.mockImplementation((actual) => ({
    async withCurrentSnapshot(r: unknown, work: (value: unknown) => Promise<unknown>) {
      expect(r).toEqual(request);
      return actual.transactions.run(async (facade: unknown) => {
        await actual.authority.holdUntilTransactionCompletes(facade, { tenantReference: id(4) });
        const metadata = buildInventoryConfigurationReferenceSnapshot(raw(), request, at);
        const result = await work(metadata);
        if (repeated) await work(metadata);
        await actual.authority.holdUntilTransactionCompletes(facade, { tenantReference: id(4) });
        if (changed) throw new Error("synthetic current generation changed");
        return substitute ? { wrong: true } : result;
      });
    },
  }));
});
it("derives direct requirements only from held full Recipe and resolves actual parsed owning Item associations", async () => {
  const h = options(),
    source = create(h);
  h.tenantReference = id(99);
  h.inventoryAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replacement");
  };
  await expect(
    source.withCurrentAssessment(tx, { original: "selector" }, async (c) => {
      expect(c.inventory.decision).toBe("PassForDirectInventoryConfigurationReferences");
      expect(c.inventory.resolutions[0]).toMatchObject({
        requirementReference: id(51),
        selectedItemVersion: 2,
        currentItemVersion: 2,
      });
      expect(c.childReferences).toBe("Incomplete");
      const { digest, ...body } = c;
      expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
      return "ok";
    }),
  ).resolves.toBe("ok");
});
it("refuses stale direct ingredient before downstream work", async () => {
  stale = true;
  let entered = false;
  await expect(
    create(options()).withCurrentAssessment(tx, { original: "selector" }, async () => {
      entered = true;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(entered).toBe(false);
});
it("keeps Subrecipe work explicit instead of treating no direct Item targets as complete admission", async () => {
  for (const only of [false, true]) {
    onlySub = only;
    subrecipe = !only;
    await create(options()).withCurrentAssessment(tx, { original: "selector" }, async (c) => {
      expect(c.subrecipeReferenceCount).toBe(1);
      expect(c.subrecipes).toBe("NotEvaluated");
      expect(c.publishValidation).toBe("Incomplete");
      expect(c.inventory.decision).toBe(
        only
          ? "NotApplicableForDirectIngredients"
          : "PassForDirectInventoryConfigurationReferences",
      );
    });
  }
});
it.each([
  "fields",
  "generation",
  "parent",
  "expiry",
  "backwards",
  "outerExpiry",
  "query",
  "duplicate",
  "substitute",
  "reentry",
])("refuses late %s and poisoned original Tx", async (key) => {
  const source = create(options());
  let entered = false;
  await expect(
    source.withCurrentAssessment(tx, { original: "selector" }, async () => {
      entered = true;
      if (key === "fields") denied = true;
      if (key === "generation") changed = true;
      if (key === "parent") parentLate = true;
      if (key === "expiry") clock = until;
      if (key === "backwards") clock = "2026-09-29T11:59:59.999Z";
      if (key === "outerExpiry") outerExpiry = true;
      if (key === "query") tx.query = vi.fn(async () => ({ rows: [] }));
      if (key === "duplicate") repeated = true;
      if (key === "substitute") substitute = true;
      if (key === "reentry")
        await source
          .withCurrentAssessment(tx, { original: "selector" }, async () => "no")
          .catch(() => undefined);
      return "no";
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(entered).toBe(true);
  await expect(
    source.withCurrentAssessment(tx, { original: "selector" }, async () => "no"),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
