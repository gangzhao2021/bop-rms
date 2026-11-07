import { describe, expect, it } from "vitest";
import {
  applyStockPlaceCommand,
  type StockSite,
  type StorageLocation,
} from "../domain/stock-place.js";

const id = (n: number) => "01909a03-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const context = (minute = 0) => ({
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  occurredAt: `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`,
});
const site = () =>
  applyStockPlaceCommand<StockSite>(
    null,
    {
      kind: "StockSite",
      action: "Create",
      stockSiteReference: id(10),
      payload: { siteKind: "Store", code: "MAIN", isDefault: true, localizedNames: { en: "Main" } },
    },
    context(),
  );
const fridge = (isDefault = false) =>
  applyStockPlaceCommand<StorageLocation>(
    null,
    {
      kind: "StorageLocation",
      action: "Create",
      locationReference: id(20),
      payload: {
        stockSiteReference: id(10),
        code: "FRIDGE",
        isDefault,
        localizedNames: { en: "Fridge", "zh-CN": "冷藏柜" },
        temperatureZone: "Chilled",
        sortOrder: 1,
      },
    },
    context(),
  );

describe("applyStockPlaceCommand", () => {
  it("creates an active Store site and a Chilled location", () => {
    expect(site()).toMatchObject({ siteKind: "Store", isDefault: true, lifecycle: "Active" });
    expect(fridge()).toMatchObject({
      stockSiteReference: id(10),
      temperatureZone: "Chilled",
      aggregateVersion: 1,
      localizedNames: { en: "Fridge", "zh-CN": "冷藏柜" },
    });
  });
  it("renames and rezones with the expected version, then deactivates and reactivates", () => {
    const renamed = applyStockPlaceCommand(
      fridge(),
      {
        kind: "StorageLocation",
        action: "Update",
        expectedVersion: 1,
        payload: { localizedNames: { en: "Walk-in" }, temperatureZone: "Frozen", sortOrder: 2 },
      },
      context(1),
    );
    expect(renamed).toMatchObject({ aggregateVersion: 2, temperatureZone: "Frozen", sortOrder: 2 });
    const off = applyStockPlaceCommand(
      renamed,
      { kind: "StorageLocation", action: "Deactivate", expectedVersion: 2 },
      context(2),
    );
    expect(off.lifecycle).toBe("Inactive");
    expect(() =>
      applyStockPlaceCommand(
        off,
        { kind: "StorageLocation", action: "Deactivate", expectedVersion: 3 },
        context(3),
      ),
    ).toThrow(expect.objectContaining({ code: "STOCK_PLACE_CONFLICT" }));
    expect(
      applyStockPlaceCommand(
        off,
        { kind: "StorageLocation", action: "Activate", expectedVersion: 3 },
        context(3),
      ).lifecycle,
    ).toBe("Active");
  });
  it("never deactivates a default place", () => {
    expect(() =>
      applyStockPlaceCommand(
        fridge(true),
        { kind: "StorageLocation", action: "Deactivate", expectedVersion: 1 },
        context(1),
      ),
    ).toThrow(expect.objectContaining({ code: "STOCK_PLACE_DEFAULT_REQUIRED" }));
  });
  it("rejects stale versions, other Stores, wrong kinds and invalid fields", () => {
    const deactivate = {
      kind: "StorageLocation",
      action: "Deactivate",
      expectedVersion: 1,
    } as const;
    expect(() =>
      applyStockPlaceCommand(fridge(), { ...deactivate, expectedVersion: 2 }, context(1)),
    ).toThrow(expect.objectContaining({ code: "STOCK_PLACE_CONFLICT" }));
    expect(() =>
      applyStockPlaceCommand(fridge(), deactivate, { ...context(1), storeReference: id(99) }),
    ).toThrow(expect.objectContaining({ code: "STOCK_PLACE_NOT_FOUND" }));
    expect(() =>
      applyStockPlaceCommand(fridge(), { ...deactivate, kind: "StockSite" }, context(1)),
    ).toThrow(expect.objectContaining({ code: "STOCK_PLACE_INVALID" }));
    expect(() =>
      applyStockPlaceCommand(
        null,
        {
          kind: "StorageLocation",
          action: "Create",
          locationReference: id(21),
          payload: {
            stockSiteReference: id(10),
            code: "bad code",
            isDefault: false,
            localizedNames: { en: "X" },
            temperatureZone: "Ambient",
            sortOrder: 0,
          },
        },
        context(),
      ),
    ).toThrow(expect.objectContaining({ code: "STOCK_PLACE_INVALID" }));
  });
});
