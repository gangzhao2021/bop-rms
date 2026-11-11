import { describe, expect, it } from "vitest";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import {
  parseKitchenBoardView,
  parseKitchenRouteReference,
  parseKitchenWorkItemView,
} from "./kitchen-board.js";
describe("WP-1804 Kitchen Board contract", () => {
  it("accepts a closed Store-scoped queue", () => {
    expect(parseKitchenBoardView(kitchenBoardFixture()).items).toHaveLength(1);
  });
  it("accepts explicitly unavailable Station display labels without exposing a reference", () => {
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [{ ...kitchenItemFixture(), stationLabel: null }],
    });
    expect(view.items[0]?.stationLabel).toBeNull();
  });
  it("rejects invalid routes, open DTOs and quantity drift", () => {
    expect(() => parseKitchenRouteReference("bad")).toThrow("KITCHEN_BOARD_INVALID");
    expect(() => parseKitchenBoardView({ ...kitchenBoardFixture(), extra: true })).toThrow(
      "KITCHEN_BOARD_INVALID",
    );
    expect(() =>
      parseKitchenWorkItemView({ ...kitchenItemFixture(), completedQuantity: 3 }),
    ).toThrow("KITCHEN_BOARD_INVALID");
    expect(() => {
      const item = { ...kitchenItemFixture() };
      Reflect.deleteProperty(item, "selectedOptions");
      parseKitchenWorkItemView(item);
    }).toThrow("KITCHEN_BOARD_INVALID");
    expect(() =>
      parseKitchenWorkItemView({
        ...kitchenItemFixture(),
        selectedOptions: [{ displayName: "Extra mushrooms", quantity: 0 }],
      }),
    ).toThrow("KITCHEN_BOARD_INVALID");
  });
});

it("Owner 2026-11-03: a round from a paper slip stays marked on the board", () => {
  expect(
    parseKitchenWorkItemView({ ...kitchenItemFixture(), takenOnPaper: true }).takenOnPaper,
  ).toBe(true);
  expect(parseKitchenWorkItemView(kitchenItemFixture()).takenOnPaper).toBeUndefined();
});
it("WP-2423 M10: refunded units the kitchen is told not to make, never more than the dish has", () => {
  const item = kitchenItemFixture();
  expect(parseKitchenWorkItemView({ ...item, refundedQuantity: 1 }).refundedQuantity).toBe(1);
  expect(parseKitchenWorkItemView(item).refundedQuantity).toBeUndefined();
  expect(() =>
    parseKitchenWorkItemView({ ...item, refundedQuantity: Number(item.requiredQuantity) + 1 }),
  ).toThrow();
  expect(() => parseKitchenWorkItemView({ ...item, refundedQuantity: 0 })).toThrow();
  // Who refunded them: names only, with the refunded units.
  expect(
    parseKitchenWorkItemView({ ...item, refundedQuantity: 1, refundedBy: ["Mia"] }).refundedBy,
  ).toEqual(["Mia"]);
  expect(() => parseKitchenWorkItemView({ ...item, refundedBy: ["Mia"] })).toThrow();
  expect(() =>
    parseKitchenWorkItemView({ ...item, refundedQuantity: 1, refundedBy: [] }),
  ).toThrow();
});
