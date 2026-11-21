import { expect, it } from "vitest";
import { dishProgressText } from "./DiningSessionPage.js";

const dish = (
  progress: "Waiting" | "Making" | "Ready" | "Served",
  served: number,
  quantity = 2,
) => ({
  displayName: "Ramen",
  quantity,
  servedQuantity: served,
  cancelled: false,
  lineTotal: { amountMinor: "3000", currencyCode: "CAD" },
  progress,
});

it("M91: says where each dish is in the guest's words", () => {
  expect(dishProgressText(dish("Waiting", 0))).toBe("Waiting");
  expect(dishProgressText(dish("Making", 0))).toBe("Being made");
  expect(dishProgressText(dish("Ready", 0))).toBe("Ready");
  expect(dishProgressText(dish("Ready", 1))).toBe("Served 1 of 2");
  expect(dishProgressText(dish("Served", 2))).toBe("Served 2 of 2");
  expect(dishProgressText(dish("Served", 1, 1))).toBe("Served");
});
