import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceOrderStatusPoll,
  nextOrderStatusPollDelayMs,
  orderAwaitingCollectionPollIntervalMs,
  orderReceivedPollIntervalMs,
  orderStatusPollErrorCapMs,
  orderStatusPollIntervalMs,
  startOrderStatusPolling,
  stoppedOrderStatusPoll,
  type OrderStatusPoll,
} from "./OrderStatusPage.js";
import type { OrderStatusController } from "./order-status-controller.js";
import type { OrderStatusState, OrderStatusView } from "./types.js";

const id = (n: number) => `018f7a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function view(
  canonicalPhase: OrderStatusView["order"]["canonicalPhase"],
  options: {
    readonly orderType?: "DineIn" | "Pickup";
    readonly collected?: boolean;
    readonly kitchen?: "Queued" | "InProgress" | "Ready";
  } = {},
): OrderStatusView {
  return {
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    sourceCheckpoint: id(2),
    projectedAt: "2026-08-11T14:00:00.000Z",
    freshnessStatus: "Fresh",
    ...(options.kitchen
      ? {
          sources: {
            checkedAt: "2026-08-11T14:00:00.000Z",
            payments: null,
            kitchen: {
              batches: [
                {
                  orderBatchReference: id(3),
                  status: options.kitchen,
                  updatedAt: "2026-08-11T13:59:00.000Z",
                },
              ],
            },
          },
        }
      : {}),
    order: {
      orderReference: id(1),
      orderNumber: "1001",
      orderType: options.orderType ?? "Pickup",
      canonicalPhase,
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: options.collected ? "Completed" : "Unavailable",
      fulfilledAt: options.collected ? "2026-08-11T14:05:00.000Z" : null,
      eta: null,
      submittedAt: "2026-08-11T13:55:00.000Z",
      batches: [
        {
          orderBatchReference: id(3),
          submittedAt: "2026-08-11T13:55:00.000Z",
          items: [
            {
              orderItemReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: { amountMinor: 1299n, currencyCode: "CAD" },
            },
          ],
        },
      ],
    },
  };
}

const ready = (v: OrderStatusView, realtime: "unavailable" | "available" = "unavailable") =>
  ({ status: "ready", view: v, realtime, refreshing: false }) as const;
const received: OrderStatusState = {
  status: "received",
  received: {
    kind: "Received",
    orderReference: id(1),
    orderNumber: "1001",
    orderType: "Pickup",
    submittedAt: "2026-08-11T13:55:00.000Z",
    checkedAt: "2026-08-11T13:55:01.000Z",
  },
};
const delayFor = (state: OrderStatusState, previous: OrderStatusPoll = stoppedOrderStatusPoll) =>
  nextOrderStatusPollDelayMs(advanceOrderStatusPoll(previous, state));

describe("WP-2423: order status polling pace", () => {
  it("checks a ready pickup every 3 s while the guest waits at the counter", () => {
    expect(orderAwaitingCollectionPollIntervalMs).toBe(3_000);
    expect(delayFor(ready(view("Ready")))).toBe(3_000);
    // The kitchen marking every round ready also shows the code, so it is the same wait.
    expect(delayFor(ready(view("In Progress", { kitchen: "Ready" })))).toBe(3_000);
  });

  it("stops once the order is collected or otherwise settled", () => {
    expect(delayFor(ready(view("Fulfilled", { collected: true })))).toBeNull();
    expect(delayFor(ready(view("Ready", { collected: true })))).toBeNull();
    expect(delayFor(ready(view("Cancelled")))).toBeNull();
    expect(delayFor(ready(view("Rejected")))).toBeNull();
  });

  it("keeps the normal pace for other open orders and the quick pace for a just-received one", () => {
    expect(delayFor(ready(view("Submitted")))).toBe(orderStatusPollIntervalMs);
    expect(delayFor(ready(view("In Progress", { kitchen: "InProgress" })))).toBe(15_000);
    // A dine-in round that is ready is brought to the table; nobody waits at a counter.
    expect(delayFor(ready(view("Ready", { orderType: "DineIn" })))).toBe(15_000);
    expect(delayFor(received)).toBe(orderReceivedPollIntervalMs);
  });

  it("does not poll while live updates are on, offline, or before a first load succeeds", () => {
    expect(delayFor(ready(view("Ready"), "available"))).toBeNull();
    expect(delayFor({ status: "offline", view: view("Ready") })).toBeNull();
    expect(delayFor({ status: "unavailable" })).toBeNull();
    expect(delayFor({ status: "not-found" })).toBeNull();
  });

  it("backs off on failures up to a cap and resets after a success", () => {
    let poll = advanceOrderStatusPoll(stoppedOrderStatusPoll, ready(view("Ready")));
    const delays: (number | null)[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      poll = advanceOrderStatusPoll(poll, { status: "loading" });
      poll = advanceOrderStatusPoll(poll, { status: "unavailable" });
      delays.push(nextOrderStatusPollDelayMs(poll));
    }
    expect(delays).toEqual([6_000, 12_000, 15_000, 15_000, 15_000, 15_000]);
    poll = advanceOrderStatusPoll(poll, ready(view("Ready")));
    expect(poll.errors).toBe(0);
    expect(nextOrderStatusPollDelayMs(poll)).toBe(3_000);

    const normal: OrderStatusPoll[] = [1, 2, 3, 10, 100].map((errors) => ({
      mode: "active",
      errors,
    }));
    expect(normal.map(nextOrderStatusPollDelayMs)).toEqual([
      30_000,
      orderStatusPollErrorCapMs,
      60_000,
      60_000,
      60_000,
    ]);
    expect(nextOrderStatusPollDelayMs({ mode: "received", errors: 3 })).toBe(15_000);
  });
});

describe("WP-2423: the order page while the guest waits at the counter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeController(initial: OrderStatusState, reads: (() => OrderStatusState)[]) {
    let state = initial;
    const listeners = new Set<() => void>();
    const publish = (next: OrderStatusState) => {
      state = next;
      listeners.forEach((listener) => listener());
    };
    const refresh = vi.fn(async () => {
      const read = reads.shift();
      if (read) publish(read());
    });
    const controller: OrderStatusController = {
      getState: () => state,
      load: async () => undefined,
      refresh,
      setOnline: () => undefined,
      dispose: () => undefined,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return { controller, refresh, publish, getState: () => state };
  }

  it("turns a ready order to collected within 3 s of the handoff, then stops checking", async () => {
    const collected = ready(view("Fulfilled", { collected: true }));
    const fake = fakeController(ready(view("Ready")), [
      () => ready(view("Ready")),
      () => collected,
    ]);
    const stop = startOrderStatusPolling(fake.controller);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    // Staff hand the order over here; the next check, 3 s later, shows it collected.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.refresh).toHaveBeenCalledTimes(2);
    expect(fake.getState()).toBe(collected);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("speeds up when the order turns ready and backs off while checks fail", async () => {
    const fake = fakeController(ready(view("In Progress", { kitchen: "InProgress" })), [
      () => ready(view("Ready")),
      () => ({ status: "unavailable" }),
      () => ({ status: "unavailable" }),
      () => ready(view("Ready")),
    ]);
    const stop = startOrderStatusPolling(fake.controller);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 15 s: now ready, at the counter
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000); // fails
    expect(fake.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(fake.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 6 s later, fails again
    expect(fake.refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(12_000); // 12 s later, succeeds
    expect(fake.refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3_000); // back to every 3 s
    expect(fake.refresh).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.refresh).toHaveBeenCalledTimes(5);
  });

  it("skips checks while the page is hidden and checks at once when it is shown again", async () => {
    const fake = fakeController(ready(view("Ready")), []);
    let visible = false;
    let onVisible: (() => void) | undefined;
    const stop = startOrderStatusPolling(fake.controller, {
      isVisible: () => visible,
      onVisible: (listener) => {
        onVisible = listener;
        return () => {
          onVisible = undefined;
        };
      },
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fake.refresh).not.toHaveBeenCalled();
    visible = true;
    onVisible?.();
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    stop();
    expect(onVisible).toBeUndefined();
  });
});
