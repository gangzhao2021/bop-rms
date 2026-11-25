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
  // Batch 63 (F13): "Served 2 of 2" is just "Served"; the count only while partly served.
  expect(dishProgressText(dish("Served", 2))).toBe("Served");
  expect(dishProgressText(dish("Served", 1, 1))).toBe("Served");
});

it("batch 63 (F12): a dish says nothing while it is where its round is", () => {
  // The round says "Sent to the kitchen"; its dishes no longer say "Waiting" under it.
  expect(dishProgressText(dish("Waiting", 0), "Queued")).toBeNull();
  expect(dishProgressText(dish("Waiting", 0), "Received")).toBeNull();
  expect(dishProgressText(dish("Making", 0), "Preparing")).toBeNull();
  expect(dishProgressText(dish("Ready", 0), "Ready")).toBeNull();
  expect(dishProgressText(dish("Served", 2), "Served")).toBeNull();
  // Where a dish is ahead of (or behind) its round, it says so.
  expect(dishProgressText(dish("Ready", 0), "Preparing")).toBe("Ready");
  expect(dishProgressText(dish("Served", 2), "Ready")).toBe("Served");
  expect(dishProgressText(dish("Waiting", 0), "Preparing")).toBe("Waiting");
  expect(dishProgressText(dish("Ready", 1), "Serving")).toBe("Served 1 of 2");
});
