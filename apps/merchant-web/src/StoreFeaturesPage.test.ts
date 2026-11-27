import { describe, expect, it, vi } from "vitest";
import {
  fullServiceSetupText,
  paidPickupAwaitingAccept,
  paidPickupWaitingText,
  waitingPickupOrders,
} from "./StoreFeaturesPage.js";
import { setLanguageForTest } from "./i18n/i18n.js";
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

it("WP-2423 live minor 32: the full-service setup names points for guests among what it turns off", () => {
  expect(fullServiceSetupText()).toContain("inventory and recipes, and points for guests");
  setLanguageForTest("zh-Hans");
  try {
    expect(fullServiceSetupText()).toContain("客人积分");
  } finally {
    setLanguageForTest("en");
  }
});

it("WP-2423 store-service-controls (v15 M128): counts paid pickup orders waiting for Accept across pages", async () => {
  const page = (items: readonly object[], next: string | null) => ({
    items,
    nextAfterOrderReference: next,
  });
  const paid = (acceptBy: string) => ({ orderType: "Pickup", acceptBy });
  const load = vi
    .fn()
    .mockResolvedValueOnce(
      page([paid("2026-11-07T01:30:00.000Z"), { orderType: "DineIn", acceptBy: null }], "x"),
    )
    .mockResolvedValueOnce(
      page([paid("2026-11-07T01:10:00.000Z"), { orderType: "Pickup", acceptBy: null }], null),
    );
  expect(await paidPickupAwaitingAccept({ load } as never)).toEqual({
    count: 2,
    earliestRefundAt: "2026-11-07T01:10:00.000Z",
  });
  expect(load.mock.calls[1]?.[0]).toBe("x");
  expect(
    await paidPickupAwaitingAccept({ load: vi.fn().mockRejectedValue(new Error("x")) } as never),
  ).toBeNull();
});

it("WP-2423 M128 review: the automatic refund is at the Store's clock, and one order reads as one", () => {
  setLanguageForTest("en");
  // 01:10 UTC is 20:10 in Toronto and 19:10 in Winnipeg, whatever the browser's own zone.
  // (Not Vancouver: BC's permanent time from November 2026 moves its offset with the tzdata release.)
  const one = paidPickupWaitingText(
    { count: 1, earliestRefundAt: "2026-11-07T01:10:00.000Z" },
    "America/Toronto",
  );
  expect(one).toMatch(
    /^1 paid pickup order is waiting for Accept \(refunded automatically at 20:10\)/u,
  );
  expect(one).toContain("Accept or cancel it in Orders first.");
  const two = paidPickupWaitingText(
    { count: 2, earliestRefundAt: "2026-11-07T01:10:00.000Z" },
    "America/Winnipeg",
  );
  expect(two).toMatch(
    /^2 paid pickup orders are waiting for Accept \(refunded automatically from 19:10\)/u,
  );
});
