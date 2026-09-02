import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ProductionBatchScreen, ProductionBatchState } from "./ProductionBatchPage.js";
import { parseProductionBatchView, ProductionBatchClientError } from "./production-batch-page.js";

const id = (n: number) => `018f9d00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const item = () => ({
  batchReference: id(1),
  batchCode: "BATCH-2026-001",
  recipeReference: id(2),
  recipeName: "Synthetic Dough",
  recipeVersion: "Version 3",
  plannedYieldMicrounits: "1000000",
  actualYieldMicrounits: "900000",
  stationCode: "PREP-A",
  plannedDate: "2026-08-13",
  status: "InProgress",
  varianceBasisPoints: 1000,
  qualityHold: true,
  ingredients: [
    {
      inventoryItemReference: id(3),
      lotReference: id(4),
      plannedQuantityMicrounits: "500000",
      actualQuantityMicrounits: "510000",
    },
  ],
});
const view = () => ({
  screenId: "KIT-PRODUCTION-BATCH",
  asOfUtc: "2026-08-13T23:00:00.000Z",
  items: [item()],
});

describe("KIT-PRODUCTION-BATCH", () => {
  it("renders every field group, filter and controlled action", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ProductionBatchScreen view={parseProductionBatchView(view())} />
      </MemoryRouter>,
    );
    for (const value of [
      "KIT-PRODUCTION-BATCH",
      "Batch / Recipe",
      "State",
      "Station",
      "Date",
      "Variance",
      "Quality hold",
      "Synthetic Dough",
      "Planned / actual yield",
      "Ingredient / Lot references",
      "Create plan",
      "Start",
      "Record yield / consumption",
      "Complete",
      "Quarantine / exception",
    ])
      expect(html).toContain(value);
  });

  it("rejects markup, URLs, floats and money-like display values", () => {
    expect(() =>
      parseProductionBatchView({ ...view(), items: [{ ...item(), recipeName: "<script>" }] }),
    ).toThrow(ProductionBatchClientError);
    expect(() =>
      parseProductionBatchView({ ...view(), items: [{ ...item(), stationCode: "https://bad" }] }),
    ).toThrow(ProductionBatchClientError);
    expect(() =>
      parseProductionBatchView({ ...view(), items: [{ ...item(), plannedYieldMicrounits: 1.5 }] }),
    ).toThrow(ProductionBatchClientError);
    expect(() =>
      parseProductionBatchView({ ...view(), items: [{ ...item(), recipeVersion: "$10" }] }),
    ).toThrow(ProductionBatchClientError);
  });

  it("renders Empty and every mandatory failure state", () => {
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <ProductionBatchScreen view={parseProductionBatchView({ ...view(), items: [] })} />
        </MemoryRouter>,
      ),
    ).toContain("No Production Batches");
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <ProductionBatchState state={state} />
          </MemoryRouter>,
        ).length,
      ).toBeGreaterThan(50);
  });
});
