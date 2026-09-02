const id = (n: number) => `018f7600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export function orderItemFixture() {
  return {
    orderReference: id(1),
    orderNumber: "ORD-1001",
    orderType: "Pickup",
    sourceChannel: "Qr",
    canonicalPhase: "Submitted",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    submittedAt: "2026-08-12T11:45:00.000Z",
    fulfilledAt: null,
    tableOrPickupReference: "Unavailable",
    promiseAt: null,
    claimStatus: "Unavailable",
    exceptionStatus: "Unavailable",
    batchCount: 1,
    itemCount: 2,
  };
}

export function orderQueueFixture() {
  return {
    screenId: "OPS-ORDER-QUEUE",
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    projectedAt: "2026-08-12T12:00:00.000Z",
    freshnessStatus: "Fresh",
    storeLabel: "Synthetic Training Store",
    businessDate: "2026-08-12",
    items: [orderItemFixture()],
  };
}

export function orderDetailFixture() {
  return {
    screenId: "OPS-ORDER-DETAIL",
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    projectedAt: "2026-08-12T12:00:00.000Z",
    freshnessStatus: "Fresh",
    order: orderItemFixture(),
    batches: [{ batchReference: id(2), sequence: 1, itemCount: 2 }],
  };
}
