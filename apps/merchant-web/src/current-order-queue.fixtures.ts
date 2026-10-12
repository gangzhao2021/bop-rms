/**
 * WP-2423 P5: synthetic current-order rows for the local demo and tests. Shapes follow
 * `parseCurrentOrderQueue` / `parseCurrentOrderDetail`; no business facts are implied.
 */
const id = (n: number) => `018f7600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

export const CURRENT_ORDER_REFS = Object.freeze({
  accepted: id(1),
  awaitingAcceptance: id(2),
  ready: id(3),
});

function row(
  reference: string,
  orderNumber: string,
  orderType: "Pickup" | "DineIn",
  sourceChannel: "Qr" | "Web",
  phase: "Submitted" | "Accepted" | "Ready",
  version: number,
  batchReference: string,
) {
  const awaiting = phase === "Submitted";
  return {
    orderReference: reference,
    orderNumber,
    orderType,
    sourceChannel,
    submittedAt: "2026-08-12T11:45:00.000Z",
    observedAt: "2026-08-12T12:00:00.000Z",
    initialBatchReference: batchReference,
    batches: [
      {
        orderBatchReference: batchReference,
        sequence: 1,
        acceptanceStatus: awaiting ? "NotAccepted" : "Accepted",
        canRequestAcceptance: awaiting,
        canCancel: phase === "Accepted",
        staffCancellation: null as null | {
          reasonCode: string;
          cancelledAt: string;
          refundStatus: "Pending" | "Refunded";
        },
        canCancelItems: false,
        /** WP-2423: an unpaid dine-in round (null: nothing due). */
        paymentDue: null as null | { status: "Failed" | "Awaiting"; cancelsAt: string | null },
      },
    ],
    canRequestAcceptance: awaiting,
    currentPhase: phase as string,
    currentVersion: version,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  };
}

export function currentOrderQueueFixture() {
  return {
    items: [
      row(CURRENT_ORDER_REFS.ready, "ORD-1003", "Pickup", "Web", "Ready", 3, id(13)),
      row(
        CURRENT_ORDER_REFS.awaitingAcceptance,
        "ORD-1002",
        "DineIn",
        "Qr",
        "Submitted",
        1,
        id(12),
      ),
      row(CURRENT_ORDER_REFS.accepted, "ORD-1001", "Pickup", "Qr", "Accepted", 2, id(11)),
    ],
    nextAfterOrderReference: null,
  };
}

export function currentOrderDetailFixture(orderReference: string) {
  const order = currentOrderQueueFixture().items.find(
    (item) => item.orderReference === orderReference,
  );
  if (!order) return null;
  const batch = order.batches[0]?.orderBatchReference ?? id(11);
  return {
    screenId: "OPS-ORDER-DETAIL",
    order,
    lines: {
      items: [
        {
          orderItemReference: id(21),
          orderBatchReference: batch,
          name: "Synthetic mushroom rice bowl",
          options: [{ name: "Extra mushrooms", quantity: 1 }],
          quantity: 2,
          customerNote: "No cilantro",
          unitPrice: money("1250"),
          subtotal: money("2500"),
          discount: money("0"),
          tax: money("325"),
          fee: money("0"),
          total: money("2825"),
          canCancel: false,
          cancellation: null,
        },
        {
          orderItemReference: id(22),
          orderBatchReference: batch,
          name: "Synthetic iced tea",
          options: [],
          quantity: 1,
          customerNote: null,
          unitPrice: money("400"),
          subtotal: money("400"),
          discount: money("0"),
          tax: money("52"),
          fee: money("0"),
          total: money("452"),
          canCancel: false,
          cancellation: null,
        },
      ],
      totals: {
        subtotal: money("2900"),
        discount: money("0"),
        tax: money("377"),
        fee: money("0"),
        total: money("3277"),
      },
    },
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** WP-2423 Q6 demo only: batches the demo Store cancelled in this browser tab (never persisted). */
const demoCancellations = new Map<string, { reasonCode: string; cancelledAt: string }>();
function applyDemoCancellation(order: ReturnType<typeof row>) {
  const batch = order.batches[0];
  const cancelled =
    batch === undefined ? undefined : demoCancellations.get(batch.orderBatchReference);
  if (!batch || !cancelled) return order;
  batch.canCancel = false;
  batch.staffCancellation = { ...cancelled, refundStatus: "Pending" };
  order.currentPhase = "Cancelled";
  order.currentVersion += 1;
  return order;
}

/**
 * A `fetch` for the local demo: current orders and one order's items come from the fixtures; a
 * cancelled demo pickup stays cancelled in this tab. Every other merchant endpoint answers 503 so
 * the pages show their unavailable states without any application request leaving the browser.
 */
export const localMerchantFetch: typeof fetch = async (input, init) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(target, "http://127.0.0.1");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && url.pathname === "/merchant/orders") {
    const queue = currentOrderQueueFixture();
    queue.items.forEach(applyDemoCancellation);
    return json(queue);
  }
  if (method === "GET" && url.pathname === "/merchant/orders/detail") {
    const detail = currentOrderDetailFixture(url.searchParams.get("order") ?? "");
    if (detail !== null) applyDemoCancellation(detail.order);
    return detail === null ? json({ error: "not_found" }, 404) : json(detail);
  }
  if (method === "POST" && url.pathname === "/merchant/orders/cancel") {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "") as Record<string, unknown>;
    } catch {
      return json({ error: "order_cancellation_input_invalid" }, 400);
    }
    const order = currentOrderQueueFixture().items.find(
      (item) => item.orderReference === body.orderReference,
    );
    const batch = order?.batches.find(
      (item) => item.orderBatchReference === body.orderBatchReference,
    );
    if (!order || !batch) return json({ error: "order_cancellation_not_found" }, 404);
    const replay = demoCancellations.get(batch.orderBatchReference);
    if (!replay && (!batch.canCancel || typeof body.reasonCode !== "string"))
      return json({ error: "order_not_cancellable" }, 409);
    if (!replay && body.expectedOrderVersion !== order.currentVersion)
      return json({ error: "order_version_conflict" }, 409);
    const cancelled = replay ?? {
      reasonCode: String(body.reasonCode),
      cancelledAt: "2026-08-12T12:01:00.000Z",
    };
    demoCancellations.set(batch.orderBatchReference, cancelled);
    return json({
      status: replay ? "AlreadyCancelled" : "Cancelled",
      orderReference: order.orderReference,
      orderBatchReference: batch.orderBatchReference,
      cancelledAt: cancelled.cancelledAt,
      refundStatus: "Pending",
    });
  }
  return json({ error: "demo_unavailable" }, 503);
};
