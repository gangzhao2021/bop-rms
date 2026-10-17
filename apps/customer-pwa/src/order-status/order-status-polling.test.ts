import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceOrderStatusPoll,
  nextOrderStatusPollDelayMs,
  orderAwaitingAcceptancePollIntervalMs,
  orderAwaitingCollectionPollIntervalMs,
  orderPreparingPollIntervalMs,
  orderReceivedPollIntervalMs,
  orderStatusPollErrorCapMs,
  orderStatusPollIntervalMs,
  startOrderStatusPolling,
  stoppedOrderStatusPoll,
  type OrderStatusPoll,
} from "./OrderStatusPage.js";
import type { OrderStatusController } from "./order-status-controller.js";
import type { OrderReceivedView, OrderStatusState, OrderStatusView } from "./types.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createHttpOrderStatusClient } from "./order-status-client.js";
import {
  v15PickupOrderReference,
  v15PickupStatusBody,
  type V15PickupStage,
} from "./v15-pickup-status.fixture.js";

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

  it("checks an accepted order every 3 s while the kitchen makes it (v15 2026-10-16: ready took 13 s)", () => {
    expect(orderPreparingPollIntervalMs).toBe(3_000);
    expect(delayFor(ready(view("Accepted")))).toBe(3_000);
    expect(delayFor(ready(view("Accepted", { kitchen: "Queued" })))).toBe(3_000);
    expect(delayFor(ready(view("In Progress", { kitchen: "InProgress" })))).toBe(3_000);
    expect(delayFor(ready(view("In Progress", { orderType: "DineIn", kitchen: "Queued" })))).toBe(
      3_000,
    );
    // Live updates, when a deployment has them, still replace polling.
    expect(delayFor(ready(view("Accepted"), "available"))).toBeNull();
  });

  it("keeps the normal pace for other open orders and the quick pace for a just-received one", () => {
    expect(delayFor(ready(view("Submitted")))).toBe(orderStatusPollIntervalMs);
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

  it("shows ready within 3 s of the kitchen finishing and backs off while checks fail", async () => {
    const fake = fakeController(ready(view("In Progress", { kitchen: "InProgress" })), [
      () => ready(view("In Progress", { kitchen: "InProgress" })),
      () => ready(view("Ready")),
      () => ({ status: "unavailable" }),
      () => ({ status: "unavailable" }),
      () => ready(view("Ready")),
    ]);
    const stop = startOrderStatusPolling(fake.controller);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fake.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 3 s: still being made
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    expect(fake.getState()).toEqual(ready(view("In Progress", { kitchen: "InProgress" })));
    // The kitchen finishes here; the next check, 3 s later, shows the code.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.refresh).toHaveBeenCalledTimes(2);
    expect(fake.getState()).toEqual(ready(view("Ready")));
    await vi.advanceTimersByTimeAsync(3_000); // fails
    expect(fake.refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(fake.refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); // 6 s later, fails again
    expect(fake.refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(12_000); // 12 s later, succeeds
    expect(fake.refresh).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(3_000); // back to every 3 s
    expect(fake.refresh).toHaveBeenCalledTimes(6);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.refresh).toHaveBeenCalledTimes(6);
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

describe("WP-2423 (v15 2026-10-17): pace from the status body the pilot actually sends", () => {
  afterEach(() => setCustomerCsrfCredential(null));

  async function decoded(stage: V15PickupStage): Promise<OrderStatusView> {
    setCustomerCsrfCredential("a".repeat(43));
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(v15PickupStatusBody(stage)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    // Decoded exactly as the page decodes it (the client's own strict parser).
    const result = (await createHttpOrderStatusClient(request).load(v15PickupOrderReference)) as
      OrderStatusView | OrderReceivedView;
    if (!("projectionName" in result)) throw new Error("fixture decoded as received");
    return result;
  }

  it("keeps the phase at Submitted until collection, as the pilot does", async () => {
    for (const stage of ["awaiting-acceptance", "queued", "preparing", "ready"] as const)
      expect((await decoded(stage)).order.canonicalPhase).toBe("Submitted");
    expect((await decoded("collected")).order.canonicalPhase).toBe("Fulfilled");
  });

  it.each([
    ["awaiting-acceptance", orderAwaitingAcceptancePollIntervalMs],
    ["queued", orderPreparingPollIntervalMs],
    ["preparing", orderPreparingPollIntervalMs],
    ["ready", orderAwaitingCollectionPollIntervalMs],
    ["collected", null],
  ] as const)("checks a %s pickup after %s ms", async (stage, delay) => {
    expect(delayFor(ready(await decoded(stage)))).toBe(delay);
  });

  it("checks a paid pickup every 5 s until the Store accepts (v15 ac46bf22: accepted showed up to 15 s late)", async () => {
    expect(orderAwaitingAcceptancePollIntervalMs).toBe(5_000);
    const waiting = await decoded("awaiting-acceptance");
    const sources = waiting.sources;
    if (sources === undefined) throw new Error("fixture has no sources");
    // Not paid yet, held while the Store is offline, or not accepted: not this wait.
    const unpaid = { ...waiting, sources: { ...sources, payments: [] } };
    const offline = {
      ...waiting,
      sources: { ...sources, storeAcceptance: { state: "AwaitingStore" as const } },
    };
    const notAccepted = {
      ...waiting,
      sources: {
        ...sources,
        storeAcceptance: {
          state: "NotAccepted" as const,
          closedAt: "2026-10-17T01:49:10.000Z",
          refundStatus: "Pending" as const,
        },
      },
    };
    expect(delayFor(ready(unpaid))).toBe(orderStatusPollIntervalMs);
    expect(delayFor(ready(offline))).toBe(orderStatusPollIntervalMs);
    expect(delayFor(ready(notAccepted))).toBe(orderStatusPollIntervalMs);
    expect(delayFor(ready(waiting, "available"))).toBeNull();
    // Failures back off from 5 s up to the normal 15 s pace; a success returns to 5 s.
    let poll = advanceOrderStatusPoll(stoppedOrderStatusPoll, ready(waiting));
    const delays: (number | null)[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      poll = advanceOrderStatusPoll(poll, { status: "unavailable" });
      delays.push(nextOrderStatusPollDelayMs(poll));
    }
    expect(delays).toEqual([10_000, 15_000, 15_000]);
    expect(nextOrderStatusPollDelayMs(advanceOrderStatusPoll(poll, ready(waiting)))).toBe(5_000);
  });

  it("shows accepted within 5 s of the Store accepting, and skips checks while hidden", async () => {
    vi.useFakeTimers();
    try {
      const waiting = ready(await decoded("awaiting-acceptance"));
      const queued = ready(await decoded("queued"));
      let state: OrderStatusState = waiting;
      const reads = [waiting, queued];
      const listeners = new Set<() => void>();
      const refresh = vi.fn(async () => {
        const next = reads.shift();
        if (next) {
          state = next;
          listeners.forEach((listener) => listener());
        }
      });
      let visible = true;
      const stop = startOrderStatusPolling(
        {
          getState: () => state,
          load: async () => undefined,
          refresh,
          setOnline: () => undefined,
          dispose: () => undefined,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        { isVisible: () => visible, onVisible: () => () => undefined },
      );
      await vi.advanceTimersByTimeAsync(4_999);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(state).toBe(waiting);
      // The Store accepts just after this check; the next one, 5 s later, shows it.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state).toBe(queued);
      expect(refresh).toHaveBeenCalledTimes(2);
      visible = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows ready within 3 s of the kitchen finishing (v15: 13 s at the 15 s pace)", async () => {
    vi.useFakeTimers();
    try {
      const queued = ready(await decoded("queued"));
      const preparing = ready(await decoded("preparing"));
      const done = ready(await decoded("ready"));
      let state: OrderStatusState = queued;
      const reads = [preparing, done];
      const listeners = new Set<() => void>();
      const refresh = vi.fn(async () => {
        const next = reads.shift();
        if (next) {
          state = next;
          listeners.forEach((listener) => listener());
        }
      });
      const stop = startOrderStatusPolling({
        getState: () => state,
        load: async () => undefined,
        refresh,
        setOnline: () => undefined,
        dispose: () => undefined,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(state).toBe(preparing);
      // The kitchen finishes just after this check; the next one, 3 s later, shows it ready.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(state).toBe(done);
      expect(refresh).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
