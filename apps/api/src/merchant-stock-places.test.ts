import { describe, expect, it } from "vitest";
import { parseStockPlaceCommandBody } from "./merchant-stock-places.js";

const id = (n: number) => "01909a10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
describe("WP-2423 stock place command body", () => {
  it.each([
    {
      operation: "SetupDefaults",
      siteOperationReference: id(1),
      locationOperationReference: id(2),
      siteName: "Store",
      locationCode: "BACK",
      locationName: "Back room",
      temperatureZone: "Ambient",
    },
    {
      operation: "CreateLocation",
      operationReference: id(1),
      stockSiteReference: id(3),
      code: "FRIDGE-1",
      name: "Walk-in fridge",
      temperatureZone: "Chilled",
      sortOrder: 1,
    },
    {
      operation: "DeactivateLocation",
      operationReference: id(1),
      locationReference: id(4),
      expectedVersion: 2,
    },
  ])("accepts $operation", (value) => {
    expect(parseStockPlaceCommandBody(value).operation).toBe(value.operation);
  });
  it.each([
    [
      "one operation reference for both setup writes",
      {
        operation: "SetupDefaults",
        siteOperationReference: id(1),
        locationOperationReference: id(1),
        siteName: "S",
        locationCode: "B",
        locationName: "B",
        temperatureZone: "Ambient",
      },
    ],
    [
      "a lower-case code",
      {
        operation: "CreateLocation",
        operationReference: id(1),
        stockSiteReference: id(3),
        code: "fridge",
        name: "F",
        temperatureZone: "Chilled",
        sortOrder: 1,
      },
    ],
    [
      "an unknown zone",
      {
        operation: "CreateLocation",
        operationReference: id(1),
        stockSiteReference: id(3),
        code: "F",
        name: "F",
        temperatureZone: "Hot",
        sortOrder: 1,
      },
    ],
    [
      "a default flag from the client",
      {
        operation: "CreateLocation",
        operationReference: id(1),
        stockSiteReference: id(3),
        code: "F",
        name: "F",
        temperatureZone: "Chilled",
        sortOrder: 1,
        isDefault: true,
      },
    ],
    [
      "a padded name",
      {
        operation: "UpdateSite",
        operationReference: id(1),
        stockSiteReference: id(3),
        expectedVersion: 1,
        name: " Store",
      },
    ],
  ])("refuses %s", (_label, value) => {
    expect(() => parseStockPlaceCommandBody(value)).toThrow(/Invalid/u);
  });
});
