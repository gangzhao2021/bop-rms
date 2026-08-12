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
  it("rejects invalid routes, open DTOs and quantity drift", () => {
    expect(() => parseKitchenRouteReference("bad")).toThrow("KITCHEN_BOARD_INVALID");
    expect(() => parseKitchenBoardView({ ...kitchenBoardFixture(), extra: true })).toThrow(
      "KITCHEN_BOARD_INVALID",
    );
    expect(() =>
      parseKitchenWorkItemView({ ...kitchenItemFixture(), completedQuantity: 3 }),
    ).toThrow("KITCHEN_BOARD_INVALID");
  });
});
