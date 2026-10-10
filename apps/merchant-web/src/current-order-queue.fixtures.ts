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
      },
    ],
    canRequestAcceptance: awaiting,
    currentPhase: phase,
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

/**
 * A `fetch` for the local demo: current orders and one order's items come from the fixtures;
 * every other merchant endpoint answers 503 so the pages show their unavailable states without
 * any application request leaving the browser.
 */
export const localMerchantFetch: typeof fetch = async (input, init) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(target, "http://127.0.0.1");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && url.pathname === "/merchant/orders")
    return json(currentOrderQueueFixture());
  if (method === "GET" && url.pathname === "/merchant/orders/detail") {
    const detail = currentOrderDetailFixture(url.searchParams.get("order") ?? "");
    return detail === null ? json({ error: "not_found" }, 404) : json(detail);
  }
  return json({ error: "demo_unavailable" }, 503);
};
