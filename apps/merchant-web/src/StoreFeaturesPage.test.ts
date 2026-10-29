import { describe, expect, it } from "vitest";
import { waitingPickupOrders } from "./StoreFeaturesPage.js";
import { PickupClientError, type PickupClient } from "./pickup.js";

describe("WP-2423 item 8 ⑦: pickup orders still waiting before pickup is turned off", () => {
  const pages = (sizes: readonly number[]): PickupClient & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      loadQueue: async (input) => {
        calls.push(input);
        const index = calls.length - 1;
        return {
          items: Array.from({ length: sizes[index] ?? 0 }, () => ({})),
          nextAfterFulfillmentReference: index < sizes.length - 1 ? "after-" + index : null,
        };
      },
    };
  };
  it("counts every page of the current pickup queue, without handed-over orders", async () => {
    const client = pages([50, 3]);
    expect(await waitingPickupOrders(client)).toBe(53);
    expect(client.calls).toEqual([
      { afterFulfillmentReference: null, includeCompleted: false },
      { afterFulfillmentReference: "after-0", includeCompleted: false },
    ]);
    expect(await waitingPickupOrders(pages([0]))).toBe(0);
  });
  it("gives no number when the queue can't be read", async () => {
    expect(
      await waitingPickupOrders({
        loadQueue: () => Promise.reject(new PickupClientError("PermissionDenied")),
      }),
    ).toBeNull();
  });
});
