import { createEffectivePeriod } from "@bop/effective-period";
import { describe, expect, it } from "vitest";
import {
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  createPostgresRecipeQueryStore,
  type RecipeSnapshot,
} from "../index.js";

const id = (n: number) =>
  parseRecipeReference(`018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-13T18:00:00.000Z";
const period = createEffectivePeriod({
  timeZone: "America/Toronto",
  effectiveFrom: {
    instant: "2026-08-01T04:00:00.000Z" as never,
    localDateTime: "2026-08-01T00:00:00.000",
    utcOffsetMinutes: -240,
  },
  effectiveUntil: null,
});
function recipe(
  options: { version?: number; lifecycle?: RecipeSnapshot["lifecycle"]; sub?: RecipeSnapshot } = {},
): RecipeSnapshot {
  const version = options.version ?? 1;
  return {
    recipeReference: id(1),
    versionReference: id(version + 1),
    brandReference: id(10),
    stableCode: parseRecipeCode("SYNTHETIC_RECIPE"),
    aggregateVersion: version,
    versionNumber: version,
    snapshotDigest: parseRecipeDigest(`sha256:${version.toString(16).repeat(64)}`),
    lifecycle: options.lifecycle ?? "Draft",
    displayNameCode: parseRecipeCode("SYNTHETIC_NAME"),
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: parseRecipeCode("PORTION"),
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(20),
        sourceKind: options.sub ? "SubRecipe" : "InventoryItem",
        sourceReference: options.sub?.recipeReference ?? id(21),
        sourceVersionReference: options.sub?.versionReference ?? id(22),
        quantityMicrounits: "1000000",
        unitDimension: "Mass",
        conversionNumerator: "2",
        conversionDenominator: "1",
        lossBasisPoints: 1000,
        unitCostMinorNumerator: "3",
        unitCostDenominator: "1000000",
        allergens: [{ allergenReference: id(30), evidenceReference: id(31), verified: true }],
      },
    ],
    preparationVersionReference: id(40),
    steps: [
      {
        stepReference: id(41),
        sequenceGroup: 0,
        instructionCode: parseRecipeCode("MIX"),
        durationSeconds: 60,
        capabilityCode: parseRecipeCode("PREP"),
      },
    ],
    substitutionPolicyReference: null,
    effectivePeriod: period,
    invalidationReasonCode:
      options.lifecycle === "Invalidated" ? parseRecipeCode("SAFETY_REVIEW") : null,
    createdAt: at,
  };
}
describe("Recipe query repository", () => {
  function store(result: unknown) {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const repository = createPostgresRecipeQueryStore(
      {
        async run(work) {
          return work({
            async query(sql, values) {
              calls.push({ sql, values });
              return sql.startsWith("SELECT set_config") ? { rows: [] } : result;
            },
          });
        },
      },
      id(10),
    );
    return { repository, calls };
  }
  it("restores the complete current snapshot under explicit Brand scope", async () => {
    const snapshot = recipe();
    const target = store({ rows: [{ snapshot, version: 1 }] });
    expect(await target.repository.load(snapshot.recipeReference)).toEqual(snapshot);
    expect(target.calls[0]?.values).toEqual([id(10)]);
    expect(target.calls[1]?.values).toEqual([id(10), snapshot.recipeReference]);
  });
  it("distinguishes absent rows from incomplete or cross-Brand history", async () => {
    expect(await store({ rows: [] }).repository.load(id(1))).toBeNull();
    for (const snapshot of [null, { ...recipe(), brandReference: id(99) }]) {
      await expect(
        store({ rows: [{ snapshot, version: 1 }] }).repository.load(id(1)),
      ).rejects.toMatchObject({
        code: "RECIPE_DEPENDENCY_UNAVAILABLE",
      });
    }
  });
  it("restores original operation and rejects mismatched event evidence", async () => {
    const aggregate = recipe();
    const record = {
      action: "CreateDraft",
      operationReference: id(70),
      operationIntentHash: "sha256:" + "a".repeat(64),
      actorReference: id(3),
      publicationEvidence: null,
      aggregate,
      event: {
        eventType: "RecipeDraftCreated",
        recipeReference: aggregate.recipeReference,
        versionReference: aggregate.versionReference,
        brandReference: aggregate.brandReference,
        aggregateVersion: aggregate.aggregateVersion,
        lifecycle: aggregate.lifecycle,
        snapshotDigest: aggregate.snapshotDigest,
        occurredAt: aggregate.createdAt,
      },
    };
    expect(await store({ rows: [{ record }] }).repository.resolveOperation(id(70))).toEqual(record);
    await expect(
      store({
        rows: [{ record: { ...record, event: { ...record.event, brandReference: id(99) } } }],
      }).repository.resolveOperation(id(70)),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  });
  it("rejects code availability requests for a different Brand", async () => {
    await expect(
      store({ rows: [] }).repository.codeAvailable({
        brandReference: id(99),
        stableCode: parseRecipeCode("SYNTHETIC"),
        excludingRecipeReference: null,
      }),
    ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
  });
});
