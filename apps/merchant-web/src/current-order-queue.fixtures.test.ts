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
  it("WP-2423 Q6: cancels the demo's accepted pickup in this tab and replays the same answer", async () => {
    const before = parseCurrentOrderQueue(currentOrderQueueFixture(), null).items.find(
      (item) => item.orderReference === CURRENT_ORDER_REFS.accepted,
    );
    const batch = before?.batches[0];
    if (!before || !batch?.canCancel) throw new Error("fixture");
    const body = JSON.stringify({
      orderReference: before.orderReference,
      orderBatchReference: batch.orderBatchReference,
      expectedOrderVersion: 1,
      operationReference: "018f7600-0000-7000-8000-000000000500",
      reasonCode: "SOLD_OUT",
    });
    const post = (value: string) =>
      localMerchantFetch("/merchant/orders/cancel", { method: "POST", body: value });
    expect((await post(body)).status).toBe(409);
    const accepted = body.replace('"expectedOrderVersion":1', '"expectedOrderVersion":2');
    expect((await post(accepted)).status).toBe(200);
    expect(await (await post(accepted)).json()).toMatchObject({ status: "AlreadyCancelled" });
    const queue = parseCurrentOrderQueue(
      await (await localMerchantFetch("/merchant/orders")).json(),
      null,
    );
    const after = queue.items.find((item) => item.orderReference === CURRENT_ORDER_REFS.accepted);
    expect(after?.currentPhase).toBe("Cancelled");
    expect(after?.batches[0]?.staffCancellation).toMatchObject({
      reasonCode: "SOLD_OUT",
      refundStatus: "Pending",
    });
    const detail = parseCurrentOrderDetail(
      await (
        await localMerchantFetch("/merchant/orders/detail?order=" + CURRENT_ORDER_REFS.accepted)
      ).json(),
      CURRENT_ORDER_REFS.accepted,
    );
    expect(detail.order.batches[0]?.canCancel).toBe(false);
  });
});
