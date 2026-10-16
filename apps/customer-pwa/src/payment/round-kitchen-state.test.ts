import { describe, expect, it, vi } from "vitest";
import {
  OrderStatusClientError,
  parseOrderStatusView,
  type CustomerOrderStatusClient,
} from "../order-status/order-status-controller.js";
import {
  createRoundKitchenWatch,
  paidIntroText,
  roundKitchenPollLimit,
  roundKitchenState,
  type RoundKitchenState,
} from "./round-kitchen-state.js";

const id = (n: number) => `018f7a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const order = id(1),
  round = id(3);

function status(kitchen: null | { status: "Queued" | "InProgress" | "Ready" | "Cancelled" }) {
  return {
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    sourceCheckpoint: id(2),
    projectedAt: "2026-08-11T14:00:00.000Z",
    freshnessStatus: "Fresh",
    order: {
      orderReference: order,
      orderNumber: "9",
      orderType: "DineIn",
      canonicalPhase: "Submitted",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Unavailable",
      fulfilledAt: null,
      eta: null,
      submittedAt: "2026-08-11T13:55:00.000Z",
      batches: [
        {
          orderBatchReference: round,
          submittedAt: "2026-08-11T13:55:00.000Z",
          items: [
            {
              orderItemReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 2,
              lineTotal: { amountMinor: 2598n, currencyCode: "CAD" },
            },
          ],
        },
      ],
    },
    sources: {
      checkedAt: "2026-08-11T14:00:00.000Z",
      kitchen:
        kitchen === null
          ? null
          : {
              batches: [
                {
                  orderBatchReference: round,
                  status: kitchen.status,
                  updatedAt: "2026-08-11T13:59:00.000Z",
                },
              ],
            },
      payments: [
        {
          status: "Succeeded",
          occurredAt: "2026-08-11T13:56:00.000Z",
          amount: { amountMinor: 2598n, currencyCode: "CAD" },
          freshnessStatus: "Fresh",
        },
      ],
    },
  };
}

describe("WP-2423 paid round: sent to the kitchen only once staff accept it", () => {
  it("tells a paid round waiting for staff from one the kitchen has", () => {
    expect(roundKitchenState(parseOrderStatusView(status(null), order), round)).toBe(
      "AwaitingStaff",
    );
    expect(
      roundKitchenState(parseOrderStatusView(status({ status: "Queued" }), order), round),
    ).toBe("SentToKitchen");
    expect(roundKitchenState(parseOrderStatusView(status({ status: "Ready" }), order), round)).toBe(
      "SentToKitchen",
    );
    // A round the store cancelled, or one this order doesn't have, is never "on its way".
    const cancelled = status({ status: "Cancelled" });
    const staffCancellations = [
      {
        orderBatchReference: round,
        cancelledAt: "2026-08-11T13:59:30.000Z",
        reason: "SoldOut",
        refundStatus: "Pending",
      },
    ];
    expect(
      roundKitchenState(
        parseOrderStatusView(
          { ...cancelled, sources: { ...cancelled.sources, staffCancellations } },
          order,
        ),
        round,
      ),
    ).toBe("Other");
    // Cancelled before the kitchen had it.
    expect(
      roundKitchenState(
        parseOrderStatusView(
          { ...status(null), sources: { ...status(null).sources, staffCancellations } },
          order,
        ),
        round,
      ),
    ).toBe("Other");
    expect(
      roundKitchenState(
        parseOrderStatusView(
          { ...status(null), order: { ...status(null).order, canonicalPhase: "Cancelled" } },
          order,
        ),
        round,
      ),
    ).toBe("Other");
    expect(roundKitchenState(parseOrderStatusView(status(null), order), id(9))).toBe("Other");
  });

  it("says the payment went through and the staff will send it, then that the kitchen has it", () => {
    expect(paidIntroText("AwaitingStaff")).toBe(
      "Paid. The staff will send it to the kitchen shortly.",
    );
    expect(paidIntroText("SentToKitchen")).toBe(
      "Thank you. Your order has been sent to the kitchen.",
    );
    for (const state of ["Checking", "Other", null] as const)
      expect(paidIntroText(state)).toBe("Thank you. Your payment went through.");
  });

  it("re-checks while staff have not accepted and updates once the kitchen has it", async () => {
    const timers: (() => void)[] = [];
    const delays: number[] = [];
    const states: RoundKitchenState[] = [];
    const load = vi
      .fn()
      .mockResolvedValueOnce(status(null))
      .mockResolvedValueOnce(status(null))
      .mockResolvedValueOnce(status({ status: "Queued" }));
    const client: CustomerOrderStatusClient = { load, subscribe: () => () => undefined };
    const stop = createRoundKitchenWatch({
      client,
      orderReference: order,
      orderBatchReference: round,
      onChange: (state) => states.push(state),
      setTimer: (run, delay) => {
        timers.push(run);
        delays.push(delay);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    await vi.waitFor(() => expect(states).toEqual(["AwaitingStaff"]));
    timers.shift()?.();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(states).toEqual(["AwaitingStaff"]);
    timers.shift()?.();
    await vi.waitFor(() => expect(states).toEqual(["AwaitingStaff", "SentToKitchen"]));
    // Once the kitchen has it, nothing more is read.
    expect(timers).toHaveLength(0);
    expect(delays).toEqual([5_000, 10_000]);
    expect(load).toHaveBeenCalledWith(order);
    stop();
  });

  it("stops on an ended visit, retries a passing failure, and stops when closed", async () => {
    const states: RoundKitchenState[] = [];
    const ended = createRoundKitchenWatch({
      client: {
        load: vi.fn().mockRejectedValue(new OrderStatusClientError("permission_denied")),
        subscribe: () => () => undefined,
      },
      orderReference: order,
      orderBatchReference: round,
      onChange: (state) => states.push(state),
      setTimer: () => {
        throw new Error("must not re-check");
      },
    });
    await vi.waitFor(() => expect(states).toEqual(["Other"]));
    ended();

    const timers: (() => void)[] = [];
    const cleared: unknown[] = [];
    const retried: RoundKitchenState[] = [];
    const load = vi
      .fn()
      .mockRejectedValueOnce(new OrderStatusClientError("service_unavailable"))
      .mockResolvedValue(status(null));
    const stop = createRoundKitchenWatch({
      client: { load, subscribe: () => () => undefined },
      orderReference: order,
      orderBatchReference: round,
      onChange: (state) => retried.push(state),
      setTimer: (run) => {
        timers.push(run);
        return "timer-" + load.mock.calls.length;
      },
      clearTimer: (timer) => cleared.push(timer),
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    timers.shift()?.();
    await vi.waitFor(() => expect(retried).toEqual(["Other", "AwaitingStaff"]));
    stop();
    expect(cleared).toEqual(["timer-2"]);
    expect(roundKitchenPollLimit).toBeGreaterThan(10);
  });
});
