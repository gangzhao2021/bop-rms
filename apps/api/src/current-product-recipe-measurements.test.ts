import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  digestRecipeMeasurementContentV2,
  requireRecipeMeasurementContentDigest,
} from "@rms/recipe";
import {
  buildInventoryConfigurationReferenceSnapshot,
  buildCurrentRecipeIngredientUnitFacts,
} from "@rms/inventory";
import { createCurrentProductRecipeMeasurementsSource as create } from "./current-product-recipe-measurements.js";
const protocol = vi.hoisted(() => ({ parent: vi.fn(), graph: vi.fn(), units: vi.fn() }));
vi.mock("./current-product-published-recipe-content.js", () => ({
  createCurrentProductPublishedRecipeContentSource: () => ({ withCurrentContent: protocol.parent }),
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createCurrentPublishedRecipeMeasurementGraphSource: protocol.graph,
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresInventoryRecipeIngredientUnitSource: protocol.units,
}));
const id = (n: number) => `01902418-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  until = "2026-09-29T12:00:05.000Z",
  activation = "2026-09-30T00:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function complete(sub = false, quantity = "2000000") {
  const raw = {
    profile: "RecipeMeasurementContentV2",
    snapshot: {
      recipeReference: id(sub ? 20 : 12),
      versionReference: id(sub ? 21 : 13),
      brandReference: id(1),
      stableCode: "SYNTHETIC_RECIPE",
      aggregateVersion: 2,
      versionNumber: 2,
      snapshotDigest: digest,
      lifecycle: "Published",
      displayNameCode: "SYNTHETIC_RECIPE",
      yieldQuantityMicrounits: "1000000",
      yieldUnitCode: "PORTION",
      yieldDimension: "Count",
      ingredients: [
        {
          requirementReference: id(sub ? 51 : 52),
          sourceKind: sub ? "SubRecipe" : "InventoryItem",
          sourceReference: id(sub ? 12 : 10),
          sourceVersionReference: id(sub ? 13 : 32),
          quantityMicrounits: sub ? quantity : "1000000",
          unitDimension: sub ? "Count" : "Mass",
          conversionNumerator: "1",
          conversionDenominator: "1",
          lossBasisPoints: sub ? 0 : 500,
          unitCostMinorNumerator: "1",
          unitCostDenominator: "1000000",
          allergens: [{ allergenReference: id(60), evidenceReference: id(61), verified: true }],
        },
      ],
      preparationVersionReference: id(40),
      steps: [
        {
          stepReference: id(41),
          sequenceGroup: 0,
          instructionCode: "MIX",
          durationSeconds: 10,
          capabilityCode: "PREP",
        },
      ],
      substitutionPolicyReference: null,
      effectivePeriod: {
        timeZone: "America/Toronto",
        effectiveFrom: {
          instant: "2026-09-01T04:00:00.000Z",
          localDateTime: "2026-09-01T00:00:00.000",
          utcOffsetMinutes: -240,
        },
        effectiveUntil: null,
      },
      invalidationReasonCode: null,
      createdAt: at,
    },
    measurements: [
      {
        requirementReference: id(sub ? 51 : 52),
        usageUnitCode: sub ? "PORTION" : "KG",
        usageDimension: sub ? "Count" : "Mass",
        targetUnitCode: sub ? "PORTION" : "KG",
        targetDimension: sub ? "Count" : "Mass",
        conversionKind: sub ? "PinnedSubrecipeYieldIdentity" : "InventoryBaseUnitIdentity",
        conversionReference: null,
      },
    ],
  };
  return requireRecipeMeasurementContentDigest({
    ...raw,
    snapshot: { ...raw.snapshot, snapshotDigest: digestRecipeMeasurementContentV2(raw) },
  });
}
const row = (content: ReturnType<typeof complete>) => ({
  snapshot: content.snapshot,
  content,
  publicationOperationReference: id(70),
  publicationEvidenceDigest: digest,
});
let mode = "",
  clock = at;
const tx = { query: vi.fn(async () => ({ rows: [] })) };
function options() {
  const hold = async (actual: unknown) => {
    expect(actual).toBe(tx);
  };
  return {
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(2),
    clock: { now: () => clock },
    catalogAuthority: { holdUntilTransactionCompletes: hold },
    recipeAuthority: { holdUntilTransactionCompletes: hold },
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
    contentAuthority: { holdUntilTransactionCompletes: hold },
    graphAuthority: { holdUntilTransactionCompletes: hold },
    measurementAuthority: {
      async holdUntilTransactionCompletes(actual: unknown) {
        await hold(actual);
        if (mode === "fieldLate") throw Error("synthetic fields");
      },
    },
    inventoryAuthority: { holdUntilTransactionCompletes: hold },
    unitAuthority: {
      async holdUntilTransactionCompletes(actual: unknown) {
        await hold(actual);
        if (mode === "unitLate") throw Error("synthetic fields");
      },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mode = "";
  clock = at;
  tx.query = vi.fn(async () => ({ rows: [] }));
  protocol.parent.mockImplementation(async (_tx, _input, work) => {
    const parent = complete(true, mode === "fractional" ? "1" : "2000000");
    const child = complete();
    const answer = await work({
      validUntil: until,
      selection: { originalObservedAt: at },
      recipeContents: {
        request: { operationReference: id(3), catalogIntentDigest: digest },
        activationAt: activation,
        contents: mode === "multi" ? [row(parent), row(child)] : [row(parent)],
      },
    });
    if (mode === "parentLate") throw Error("synthetic current parent");
    if (mode === "parentDuplicate") await work({});
    if (mode === "expiryAfter") clock = until;
    return mode === "parentSubstitute" ? {} : answer;
  });
  protocol.graph.mockImplementation((o) => ({
    async withCurrentGraph(
      selector: Record<string, unknown>,
      work: (v: unknown) => Promise<unknown>,
    ) {
      const actual = await o.transactions.run((tx: unknown) => Promise.resolve(tx));
      const parent = complete(true, mode === "fractional" ? "1" : "2000000"),
        child = complete();
      const graph = {
        profile: "CurrentPublishedRecipeMeasurementGraphV2",
        tenantReference: id(4),
        request: selector.request,
        observedAt: at,
        activationAt: activation,
        validUntil: mode === "short" ? "2026-09-29T12:00:02.000Z" : until,
        rootVersionReferences:
          mode === "multi"
            ? [parent.snapshot.versionReference, child.snapshot.versionReference]
            : [parent.snapshot.versionReference],
        measurementRepresentation: "CompleteV2",
        contents: mode === "missing" ? [row(parent)] : [row(parent), row(child)],
        digest,
      };
      if (mode === "rootMismatch") graph.rootVersionReferences = [child.snapshot.versionReference];
      if (mode === "tenant") graph.tenantReference = id(9);
      if (mode === "profile") graph.profile = "PinnedPublishedRecipeMeasurementGraphV2";
      if (mode === "request") graph.request = {};
      if (mode === "observation") graph.observedAt = "2026-09-29T11:59:59.000Z";
      if (mode === "activation") graph.activationAt = at;
      if (mode === "representation") graph.measurementRepresentation = "Legacy";
      const first = graph.contents[0];
      if (!first) throw Error("fixture");
      if (mode === "publication") first.publicationOperationReference = id(71);
      if (mode === "core") first.snapshot = child.snapshot;
      if (mode === "fullMismatch") first.content = child;
      await o.authority.holdUntilTransactionCompletes(actual, {});
      const answer = await work(graph);
      if (mode === "graphDuplicate") await work(graph);
      await o.measurementAuthority.holdUntilTransactionCompletes(actual, {});
      if (mode === "graphLate") throw Error("synthetic final current root");
      return mode === "graphSubstitute" ? {} : answer;
    },
  }));
  protocol.units.mockImplementation((o) => ({
    async withCurrentUnits(
      request: Parameters<typeof buildInventoryConfigurationReferenceSnapshot>[1],
      pins: unknown,
      work: (v: unknown) => Promise<unknown>,
    ) {
      const actual = await o.transactions.run((tx: unknown) => Promise.resolve(tx));
      const scope = {
        tenantReference: request.tenantReference,
        brandReference: request.brandReference,
      };
      const metadata = buildInventoryConfigurationReferenceSnapshot(
        {
          generation: "2",
          observedAt: at,
          counts: { items: "1", versions: "2", operations: "2" },
          items: [
            {
              ...scope,
              itemReference: id(10),
              itemType: "RawMaterial",
              createdAt: at,
              precise: true,
            },
          ],
          versions: [1, 2].map((v) => ({
            ...scope,
            itemReference: id(10),
            itemVersion: String(v),
            itemType: "RawMaterial",
            lifecycle: v === 2 ? "Active" : "Inactive",
            recordedAt: at,
            precise: true,
          })),
          operations: [1, 2].map((v) => ({
            ...scope,
            itemReference: id(10),
            itemVersion: String(v),
            operationReference: id(v === 1 ? 31 : 32),
            action: v === 1 ? "Create" : "Activate",
          })),
        },
        request,
        at,
      );
      const facts = {
        ...buildCurrentRecipeIngredientUnitFacts(
          pins,
          [
            {
              itemReference: id(10),
              itemVersion: "2",
              operationReference: id(32),
              recordedAt: at,
              precise: true,
              baseUnit: {
                unitCode: mode === "base" ? "G" : "KG",
                dimension: "Mass",
                displayPrecision: 4,
                ledgerPrecision: 4,
                roundingMode: "HalfEven",
              },
              unitConversions: [],
            },
          ],
          metadata,
          request,
          at,
        ),
        validUntil: until,
      };
      if (mode === "unitRequest") facts.request = { ...facts.request, operationReference: id(999) };
      if (mode === "unitDigest") facts.digest = "sha256:" + "b".repeat(64);
      await o.authority.holdUntilTransactionCompletes(actual, {});
      const answer = await work(facts);
      if (mode === "unitDuplicate") await work(facts);
      await o.unitAuthority.holdUntilTransactionCompletes(actual, {});
      return mode === "unitSubstitute" ? {} : answer;
    },
  }));
});
it("composes full V2 child demand with actual owning arithmetic and current fact decoders", async () => {
  const answer = { ok: true };
  await expect(
    create(options()).withCurrentAssessment(tx, {}, async (v) => {
      expect(v.profile).toBe("CurrentProductRecipeMeasurementsV2");
      expect(v.precision[0]?.aggregates[0]?.baseQuantityMicrounits).toBe("2100000");
      expect(v.batches.batches[0]?.demands[0]?.sourcePath).toHaveLength(2);
      expect(v).toMatchObject({
        unitsAndConversions: "Pass",
        inventoryPrecision: "Pass",
        productQuantity: "NotEvaluated",
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
      });
      const { digest: d, ...body } = v;
      expect(d).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
      return answer;
    }),
  ).resolves.toBe(answer);
});
it("keeps multiple selected batches separate when one root is also a pinned child", async () => {
  mode = "multi";
  await create(options()).withCurrentAssessment(tx, {}, async (v) => {
    expect(v.batches.batches).toHaveLength(2);
    expect(v.precision.map((p) => p.aggregates[0]?.baseQuantityMicrounits).sort()).toEqual([
      "1050000",
      "2100000",
    ]);
  });
});
it.each([
  "missing",
  "fractional",
  "base",
  "rootMismatch",
  "tenant",
  "profile",
  "request",
  "observation",
  "activation",
  "representation",
  "publication",
  "core",
  "fullMismatch",
  "unitRequest",
  "unitDigest",
  "parentLate",
  "parentDuplicate",
  "parentSubstitute",
  "expiryAfter",
  "graphDuplicate",
  "graphSubstitute",
  "graphLate",
  "fieldLate",
  "unitLate",
  "unitDuplicate",
  "unitSubstitute",
])("refuses %s and poisons the original transaction", async (m) => {
  mode = m;
  const source = create(options());
  await expect(source.withCurrentAssessment(tx, {}, async () => true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  mode = "";
  await expect(source.withCurrentAssessment(tx, {}, async () => true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it.each(["query", "backwards", "deadline", "workError", "reentry"])(
  "refuses consumer %s after qualification",
  async (m) => {
    const source = create(options());
    await expect(
      source.withCurrentAssessment(tx, {}, async () => {
        if (m === "query") tx.query = vi.fn(async () => ({ rows: [] }));
        if (m === "backwards") clock = "2026-09-29T11:59:59.000Z";
        if (m === "deadline") clock = until;
        if (m === "workError") throw Error("synthetic consumer");
        if (m === "reentry")
          await source.withCurrentAssessment(tx, {}, async () => true).catch(() => undefined);
        return true;
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("keeps the shortest graph lease exclusive", async () => {
  mode = "short";
  await expect(
    create(options()).withCurrentAssessment(tx, {}, async (v) => {
      expect(v.validUntil).toBe("2026-09-29T12:00:02.000Z");
      clock = v.validUntil;
      return true;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("checks the original query after each in-flight source query and preserves rowCount", async () => {
  let changed = false;
  tx.query = vi.fn(async () => {
    if (changed) clock = until;
    return { rows: [], rowCount: 1 };
  });
  protocol.units.mockImplementation((o) => ({
    async withCurrentUnits() {
      return o.transactions.run(
        async (facade: {
          query: (sql: string, values: unknown[]) => Promise<{ rowCount?: number }>;
        }) => {
          expect((await facade.query("synthetic protocol", [])).rowCount).toBe(1);
          changed = true;
          await facade.query("synthetic protocol", []);
        },
      );
    },
  }));
  await expect(
    create(options()).withCurrentAssessment(tx, {}, async () => true),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
