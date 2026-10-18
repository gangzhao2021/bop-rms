import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { buildInventoryConfigurationReferenceSnapshot } from "@rms/inventory";
import { createCurrentProductRecipeDependencyGraphSource as create } from "./current-product-recipe-dependency-graph.js";
const protocol = vi.hoisted(() => ({ parent: vi.fn(), inventory: vi.fn(), graph: vi.fn() }));
vi.mock("./current-product-published-recipe-content.js", () => ({
  createCurrentProductPublishedRecipeContentSource: () => ({ withCurrentContent: protocol.parent }),
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresInventoryConfigurationReferenceSourceStore: protocol.inventory,
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createCurrentPublishedRecipeDependencyGraphSource: protocol.graph,
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
  onlySub = false,
  childStale = false,
  graphDenied = false,
  graphLate = false,
  graphRepeated = false,
  graphSubstitute = false,
  graphShort = false,
  outerBackwards = false,
  graphMismatch = "";
const until = "2026-09-29T12:00:05.000Z";
const tx = { query: vi.fn(async () => ({ rows: [] })) };
function parentContent() {
  const ingredients = [
    {
      sourceKind: onlySub ? "SubRecipe" : "InventoryItem",
      requirementReference: id(51),
      sourceReference: onlySub ? id(12) : id(10),
      sourceVersionReference: onlySub ? id(13) : stale ? id(31) : id(32),
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
      contents: [
        {
          snapshot: { recipeReference: id(20), versionReference: id(21), ingredients },
          publicationOperationReference: id(70),
          publicationEvidenceDigest: digest,
        },
      ],
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
    graphAuthority: {
      async holdUntilTransactionCompletes(actual: unknown, fields: unknown) {
        expect(actual).toBe(tx);
        expect(fields).toMatchObject({ tenantReference: id(4) });
        if (graphDenied) throw new Error("synthetic graph fields denial");
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
  childStale =
    graphDenied =
    graphLate =
    graphRepeated =
    graphSubstitute =
    graphShort =
    outerBackwards =
      false;
  graphMismatch = "";
  protocol.graph.mockImplementation((actual) => ({
    async withCurrentGraph(
      selector: { activationAt: string },
      work: (value: unknown) => Promise<unknown>,
    ) {
      const expectedRequest = {
        purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
        brandReference: id(1),
        actorReference: id(2),
        operationReference: id(3),
        catalogIntentDigest: digest,
      };
      expect(selector).toEqual({
        request: expectedRequest,
        observedAt: at,
        validUntil: until,
        activationAt: "2026-09-30T00:00:00.000Z",
        recipeVersions: [{ recipeReference: id(20), versionReference: id(21) }],
      });
      return actual.transactions.run(async (facade: unknown) => {
        await actual.authority.holdUntilTransactionCompletes(facade, { tenantReference: id(4) });
        const contents = [...parentContent().recipeContents.contents];
        if (subrecipe || onlySub)
          contents.push({
            snapshot: {
              recipeReference: id(12),
              versionReference: id(13),
              ingredients: [
                {
                  sourceKind: "InventoryItem",
                  requirementReference: id(53),
                  sourceReference: id(10),
                  sourceVersionReference: childStale ? id(31) : id(32),
                },
              ],
            },
            publicationOperationReference: id(71),
            publicationEvidenceDigest: digest,
          });
        const graph = {
          profile: "CurrentPublishedRecipeDependencyGraphV1",
          tenantReference: id(4),
          request: expectedRequest,
          observedAt: at,
          validUntil: graphShort ? "2026-09-29T12:00:03.000Z" : until,
          activationAt: selector.activationAt,
          contents,
          rootVersionReferences: [id(21)],
          subrecipeGraph: "PassForPinnedPublishedSubrecipes",
          inventoryReferences: "NotEvaluated",
          unitsAndConversions: "NotEvaluated",
          publishValidation: "Incomplete",
          eligibility: "NotEvaluated",
          digest,
        };
        if (graphMismatch === "scope") graph.tenantReference = id(99);
        if (graphMismatch === "request")
          graph.request = { ...expectedRequest, operationReference: id(99) };
        if (graphMismatch === "observation") graph.observedAt = "2026-09-29T12:00:00.001Z";
        if (graphMismatch === "activation") graph.activationAt = "2026-10-01T00:00:00.000Z";
        if (graphMismatch === "roots") graph.rootVersionReferences = [id(99)];
        const first = graph.contents[0];
        if (!first) throw new Error("synthetic root fixture missing");
        if (graphMismatch === "snapshot")
          graph.contents[0] = {
            ...first,
            snapshot: { ...first.snapshot, versionReference: id(99) },
          };
        if (graphMismatch === "proof")
          graph.contents[0] = { ...first, publicationOperationReference: id(99) };
        const result = await work(graph);
        if (graphRepeated) await work(graph);
        await actual.authority.holdUntilTransactionCompletes(facade, { tenantReference: id(4) });
        if (graphLate) throw new Error("synthetic late owning graph change");
        return graphSubstitute ? { wrong: true } : result;
      });
    },
  }));
  protocol.parent.mockImplementation(async (actual, value, work) => {
    expect(actual).toBe(tx);
    expect(value).toEqual({ original: "selector" });
    const result = await work(parentContent());
    if (parentLate) throw new Error("synthetic outer final change");
    if (outerExpiry) clock = graphShort ? "2026-09-29T12:00:03.000Z" : until;
    if (outerBackwards) clock = "2026-09-29T11:59:59.999Z";
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
it("derives child Ingredient requirements even when the root has no direct Item target", async () => {
  for (const only of [false, true]) {
    onlySub = only;
    subrecipe = !only;
    await create(options()).withCurrentAssessment(tx, { original: "selector" }, async (c) => {
      expect(c.subrecipeReferenceCount).toBe(1);
      expect(c.subrecipes).toBe("PassForPinnedPublishedSubrecipes");
      expect(c.inventory.resolutions.some((r) => r.requirementReference === id(53))).toBe(true);
      expect(c.unitsAndConversions).toBe("NotEvaluated");
      expect(c.publishValidation).toBe("Incomplete");
      expect(c.inventory.decision).toBe("PassForDirectInventoryConfigurationReferences");
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
  "graphFields",
  "graphLate",
  "graphDuplicate",
  "graphSubstitute",
  "shortGraphOuterExpiry",
  "outerBackwards",
])("refuses late %s and poisoned original Tx", async (key) => {
  if (key === "shortGraphOuterExpiry") graphShort = true;
  const source = create(options());
  let entered = false;
  await expect(
    source.withCurrentAssessment(tx, { original: "selector" }, async () => {
      entered = true;
      if (key === "graphFields") graphDenied = true;
      if (key === "graphLate") graphLate = true;
      if (key === "graphDuplicate") graphRepeated = true;
      if (key === "graphSubstitute") graphSubstitute = true;
      if (key === "shortGraphOuterExpiry") outerExpiry = true;
      if (key === "outerBackwards") outerBackwards = true;
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

it("refuses a stale Ingredient operation from a reachable exact child before downstream work", async () => {
  subrecipe = childStale = true;
  const work = vi.fn();
  await expect(
    create(options()).withCurrentAssessment(tx, { original: "selector" }, work),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(work).not.toHaveBeenCalled();
});
it.each(["scope", "request", "observation", "activation", "roots", "snapshot", "proof"])(
  "refuses original graph %s mismatch before work",
  async (key) => {
    graphMismatch = key;
    const work = vi.fn();
    await expect(
      create(options()).withCurrentAssessment(tx, { original: "selector" }, work),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(work).not.toHaveBeenCalled();
  },
);
it("captures the original graph holder before caller options are replaced", async () => {
  const h = options(),
    source = create(h);
  h.graphAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replacement");
  };
  await expect(
    source.withCurrentAssessment(tx, { original: "selector" }, async () => "ok"),
  ).resolves.toBe("ok");
});
