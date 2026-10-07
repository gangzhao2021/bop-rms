import { describe, expect, it } from "vitest";
import { parseInventoryItemCommandBody } from "./merchant-inventory-items.js";

const id = (n: number) => "01909a0e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const fields = {
  name: "Whole milk",
  unitCode: "L",
  stockTracked: true,
  lotTracking: "LotExpiryRequired",
  shelfLifeDays: 10,
  expiryWarningDays: 2,
  negativeStockPolicy: "Block",
};
const body = (overrides: Record<string, unknown> = {}) => ({
  action: "Create",
  operationReference: id(1),
  itemReference: null,
  expectedVersion: null,
  fields: { ...fields, internalCode: "MILK-WHOLE", itemType: "RawMaterial" },
  reasonCode: null,
  ...overrides,
});
describe("WP-2423 Inventory Item command body", () => {
  it("accepts create, update and lifecycle commands", () => {
    expect(parseInventoryItemCommandBody(body()).action).toBe("Create");
    expect(
      parseInventoryItemCommandBody(
        body({ action: "Update", itemReference: id(2), expectedVersion: 3, fields }),
      ).action,
    ).toBe("Update");
    expect(
      parseInventoryItemCommandBody(
        body({
          action: "Archive",
          itemReference: id(2),
          expectedVersion: 3,
          fields: null,
          reasonCode: "ITEM_DISCONTINUED",
        }),
      ).reasonCode,
    ).toBe("ITEM_DISCONTINUED");
  });
  it.each([
    [
      "an unknown unit",
      body({ fields: { ...fields, unitCode: "TON", internalCode: "X", itemType: "RawMaterial" } }),
    ],
    [
      "a client stock claim",
      body({
        action: "Archive",
        itemReference: id(2),
        expectedVersion: 1,
        fields: null,
        reasonCode: "ITEM_DISCONTINUED",
        hasNonZeroStock: false,
      }),
    ],
    [
      "identity on update",
      body({
        action: "Update",
        itemReference: id(2),
        expectedVersion: 1,
        fields: { ...fields, internalCode: "X", itemType: "RawMaterial" },
      }),
    ],
    [
      "fields on a lifecycle change",
      body({
        action: "Activate",
        itemReference: id(2),
        expectedVersion: 1,
        reasonCode: "READY",
        fields,
      }),
    ],
    [
      "a missing reason",
      body({ action: "Deactivate", itemReference: id(2), expectedVersion: 1, fields: null }),
    ],
    ["an item reference on create", body({ itemReference: id(2) })],
    ["reorder policy (not offered here)", body({ action: "SetReorderPolicy" })],
  ])("refuses %s", (_label, value) => {
    expect(() => parseInventoryItemCommandBody(value)).toThrow(/Invalid/u);
  });
});
