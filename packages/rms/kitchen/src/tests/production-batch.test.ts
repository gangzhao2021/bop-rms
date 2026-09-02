import { describe, expect, it } from "vitest";
import {
  createProductionBatch,
  observeProductionBatch,
  parseProductionCode,
  parseProductionReference,
  transitionProductionBatch,
} from "../index.js";
const raw = (n: number) => `018f9e00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const id = (n: number) => parseProductionReference(raw(n));
const at = "2026-08-14T00:00:00.000Z";
function batch(status: "Planned" | "InProgress" = "InProgress") {
  return createProductionBatch({
    productionBatchReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    recipeReference: id(5),
    recipeVersionReference: id(6),
    stationReference: id(7),
    plannedYieldMicrounits: "1000000",
    actualYieldMicrounits: null,
    ingredients: [
      {
        ingredientReference: id(8),
        inventoryItemReference: id(9),
        lotReference: id(10),
        plannedQuantityMicrounits: "600000",
        actualQuantityMicrounits: null,
      },
    ],
    status,
    qualityHold: false,
    varianceBasisPoints: null,
    qualityExceptionReasonCode: null,
    aggregateVersion: 1,
    plannedAt: at,
    observedAt: at,
  });
}
describe("Production Batch", () => {
  it("uses exact integer microunits and completes only after controlled observations", () => {
    const observed = observeProductionBatch(batch(), {
      actualYieldMicrounits: "990000",
      actualIngredientQuantities: { [id(8)]: "605000" },
      varianceThresholdBasisPoints: 200,
      qualityExceptionReasonCode: null,
      observedAt: "2026-08-14T00:01:00.000Z",
    });
    expect(observed.varianceBasisPoints).toBe(100);
    expect(transitionProductionBatch(observed, "Complete", "2026-08-14T00:02:00.000Z").status).toBe(
      "Completed",
    );
    expect(() =>
      observeProductionBatch(batch(), {
        actualYieldMicrounits: "1.5",
        actualIngredientQuantities: { [id(8)]: "1" },
        varianceThresholdBasisPoints: 200,
        qualityExceptionReasonCode: null,
        observedAt: at,
      }),
    ).toThrow();
  });
  it("requires a quality exception above threshold and preserves a quarantine fact", () => {
    expect(() =>
      observeProductionBatch(batch(), {
        actualYieldMicrounits: "700000",
        actualIngredientQuantities: { [id(8)]: "600000" },
        varianceThresholdBasisPoints: 200,
        qualityExceptionReasonCode: null,
        observedAt: at,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PRODUCTION_BATCH_QUALITY_EXCEPTION_REQUIRED" }),
    );
    const reason = parseProductionCode("YIELD_VARIANCE");
    const held = observeProductionBatch(batch(), {
      actualYieldMicrounits: "700000",
      actualIngredientQuantities: { [id(8)]: "600000" },
      varianceThresholdBasisPoints: 200,
      qualityExceptionReasonCode: reason,
      observedAt: at,
    });
    expect(held.qualityHold).toBe(true);
    expect(
      transitionProductionBatch(held, "Quarantine", "2026-08-14T00:03:00.000Z", reason).status,
    ).toBe("Quarantined");
  });
  it("rejects completion before actual consumption and Yield exist", () => {
    expect(() => transitionProductionBatch(batch(), "Complete", at)).toThrowError(
      expect.objectContaining({ code: "PRODUCTION_BATCH_OBSERVATION_INCOMPLETE" }),
    );
  });
});
