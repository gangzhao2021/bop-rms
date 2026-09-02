import { describe, expect, it } from "vitest";
import { pickupQueueFixture } from "./pickup.fixtures.js";
import { parsePickupQueueView } from "./pickup.js";
describe("WP-1805 Pickup contract", () => {
  it("accepts a closed authorized queue", () => {
    expect(parsePickupQueueView(pickupQueueFixture()).items).toHaveLength(1);
  });
  it("rejects open DTOs and impossible package counts", () => {
    expect(() => parsePickupQueueView({ ...pickupQueueFixture(), extra: true })).toThrow(
      "PICKUP_VIEW_INVALID",
    );
    const source = pickupQueueFixture();
    expect(() =>
      parsePickupQueueView({ ...source, items: [{ ...source.items[0], packageCount: 0 }] }),
    ).toThrow("PICKUP_VIEW_INVALID");
  });
});
