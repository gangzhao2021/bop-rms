import { createEffectivePeriod } from "@bop/effective-period";
import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  digestRecipeMeasurementContentV2 as digest,
  requireRecipeMeasurementContentDigest as requireDigest,
  parseRecipeMeasurementPublicationEvidence as review,
  parseRecipeCode,
  parseRecipeReference,
  parseRecipeDigest,
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

function content(published = true) {
  const snapshot = recipe({ lifecycle: published ? "Published" : "Draft" });
  const raw = {
    profile: "RecipeMeasurementContentV2",
    snapshot,
    measurements: [
      {
        requirementReference: id(20),
        usageUnitCode: "G",
        usageDimension: "Mass",
        targetUnitCode: "KG",
        targetDimension: "Mass",
        conversionKind: "InventoryRecordedConversion",
        conversionReference: id(70),
      },
    ],
  };
  return { ...raw, snapshot: { ...snapshot, snapshotDigest: digest(raw) } };
}
function evidence(c: ReturnType<typeof content>) {
  return {
    recipeReference: c.snapshot.recipeReference,
    versionReference: c.snapshot.versionReference,
    brandReference: c.snapshot.brandReference,
    snapshotDigest: c.snapshot.snapshotDigest,
    draftAuthorActorReference: id(3),
    reviews: [
      {
        reviewReference: id(80),
        reviewKind: "Cost",
        reviewerActorReference: id(4),
        evidenceDigest: "sha256:" + "b".repeat(64),
        decision: "Approved",
        reviewedAt: at,
      },
      {
        reviewReference: id(81),
        reviewKind: "FoodSafety",
        reviewerActorReference: id(5),
        evidenceDigest: "sha256:" + "c".repeat(64),
        decision: "Approved",
        reviewedAt: at,
      },
    ],
  };
}

it("hashes canonical complete explicit measurement content excluding only its own digest", () => {
  const c = content(),
    { snapshotDigest: _digest, ...snapshot } = c.snapshot;
  void _digest;
  expect(digest(c)).toBe(
    "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({ profile: c.profile, snapshot, measurements: c.measurements }),
      ),
  );
  expect(
    digest({ ...c, snapshot: { ...c.snapshot, snapshotDigest: "sha256:" + "f".repeat(64) } }),
  ).toBe(c.snapshot.snapshotDigest);
  expect(requireDigest(c)).toMatchObject(c);
  expect(review(evidence(c), c).snapshotDigest).toBe(c.snapshot.snapshotDigest);
});
it.each([
  "unit",
  "target",
  "dimension",
  "pin",
  "quantity",
  "ratio",
  "loss",
  "cost",
  "preparation",
  "step",
  "time",
  "version",
  "scope",
  "lifecycle",
])("old digest/reviews refuse changed %s content", (key) => {
  const c = content(),
    original = evidence(c),
    r = c.measurements[0],
    i = c.snapshot.ingredients[0],
    step = c.snapshot.steps[0];
  if (!r || !i || !step) throw new Error("fixture");
  if (key === "unit") r.usageUnitCode = "ML";
  if (key === "target") r.targetUnitCode = "GRAM";
  if (key === "dimension") r.targetDimension = "Volume";
  if (key === "pin") r.conversionReference = id(99);
  if (key === "quantity") Object.assign(i, { quantityMicrounits: "2000000" });
  if (key === "ratio") Object.assign(i, { conversionNumerator: "3" });
  if (key === "loss") Object.assign(i, { lossBasisPoints: 2000 });
  if (key === "cost") Object.assign(i, { unitCostMinorNumerator: "4" });
  if (key === "preparation") Object.assign(c.snapshot, { preparationVersionReference: id(99) });
  if (key === "step") Object.assign(step, { durationSeconds: 90 });
  if (key === "time") Object.assign(c.snapshot, { createdAt: "2026-08-13T18:00:00.001Z" });
  if (key === "version") Object.assign(c.snapshot, { versionReference: id(99) });
  if (key === "scope") Object.assign(c.snapshot, { brandReference: id(99) });
  if (key === "lifecycle") Object.assign(c.snapshot, { lifecycle: "Draft" });
  expect(() => requireDigest(c)).toThrowError(
    expect.objectContaining({ code: "RECIPE_INPUT_INVALID" }),
  );
  const changed = { ...c, snapshot: { ...c.snapshot, snapshotDigest: digest(c) } };
  expect(() => review(original, changed)).toThrowError(
    expect.objectContaining({ code: "RECIPE_INPUT_INVALID" }),
  );
});
it("review grammar preserves independent actual identities and exact content binding", () => {
  const c = content();
  for (const k of ["author", "duplicate", "digest", "decision", "future"]) {
    const e = evidence(c),
      r = e.reviews[0];
    if (!r) throw new Error("fixture");
    if (k === "author") r.reviewerActorReference = e.draftAuthorActorReference;
    if (k === "duplicate") e.reviews = [r, r];
    if (k === "digest") e.snapshotDigest = parseRecipeDigest("sha256:" + "f".repeat(64));
    if (k === "decision") r.decision = "Rejected";
    if (k === "future") r.reviewedAt = "2026-08-14T18:00:00.000Z";
    expect(() => review(e, c)).toThrowError(
      expect.objectContaining({ code: "RECIPE_INPUT_INVALID" }),
    );
  }
  expect(() => review(evidence(content(false)), content(false))).toThrow();
});
