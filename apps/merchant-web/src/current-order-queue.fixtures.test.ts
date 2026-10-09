import { describe, expect, it } from "vitest";
import { parseCurrentOrderDetail, parseCurrentOrderQueue } from "./current-order-queue-client.js";
import {
  CURRENT_ORDER_REFS,
  currentOrderDetailFixture,
  currentOrderQueueFixture,
  localMerchantFetch,
} from "./current-order-queue.fixtures.js";

describe("WP-2423 P5 current order demo fixtures", () => {
  it("parse under the strict queue and detail contracts", () => {
    const queue = parseCurrentOrderQueue(currentOrderQueueFixture(), null);
    expect(queue.items.map((item) => item.orderNumber)).toEqual([
      "ORD-1003",
      "ORD-1002",
      "ORD-1001",
    ]);
    expect(queue.items.filter((item) => item.canRequestAcceptance)).toHaveLength(1);
    const detail = parseCurrentOrderDetail(
      currentOrderDetailFixture(CURRENT_ORDER_REFS.accepted),
      CURRENT_ORDER_REFS.accepted,
    );
    expect(detail.lines.items).toHaveLength(2);
    expect(detail.lines.totals.total.amountMinor).toBe("3277");
    expect(currentOrderDetailFixture("018f7600-0000-7000-8000-000000000099")).toBeNull();
  });
  it("answers only the current-order reads and fails every other endpoint closed", async () => {
    expect((await localMerchantFetch("/merchant/orders")).status).toBe(200);
    expect(
      (await localMerchantFetch("/merchant/orders/detail?order=" + CURRENT_ORDER_REFS.ready))
        .status,
    ).toBe(200);
    expect(
      (
        await localMerchantFetch(
          "/merchant/orders/detail?order=018f7600-0000-7000-8000-000000000099",
        )
      ).status,
    ).toBe(404);
    expect((await localMerchantFetch("/merchant/payments", { method: "POST" })).status).toBe(503);
  });
});
