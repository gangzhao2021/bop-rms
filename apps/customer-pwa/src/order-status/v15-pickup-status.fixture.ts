/**
 * WP-2423 (v15 2026-10-17): the wire body `GET /api/v1/orders/:id/status` returns for a paid QR
 * pickup in the pilot, at each step of its life. Rebuilt from v15 order 17 (one Flat White Small,
 * $4.80 + $0.62 tax) — its status projection snapshot, kitchen ticket and outbox events — and the
 * server serializer (`apps/api/src/customer-order-status.ts`). References, times and the Store
 * contact are synthetic; nothing about a customer is included.
 *
 * What the pilot really sends, unlike older test shapes: `order.canonicalPhase` stays `Submitted`
 * from payment until the guest collects (then `Fulfilled`). Ordering's status projection is
 * advanced only by Ordering's own records (creation, added rounds, collection, termination), so
 * store acceptance and kitchen progress reach the guest through `sources.kitchen` instead:
 * `null` until the Store accepts (no kitchen ticket yet), then the ticket's batch status.
 */
export type V15PickupStage = "awaiting-acceptance" | "queued" | "preparing" | "ready" | "collected";

export const v15PickupOrderReference = "01a14783-0000-7000-8000-000000000017";
const batchReference = "01a14783-0000-7000-8000-0000000000b1";
const itemReference = "01a14783-0000-7000-8000-0000000000c1";

const submittedAt = "2026-10-17T01:39:10.472Z";
const kitchenUpdatedAt: Record<V15PickupStage, string | null> = {
  "awaiting-acceptance": null,
  queued: "2026-10-17T01:39:54.499Z",
  preparing: "2026-10-17T01:40:05.120Z",
  ready: "2026-10-17T01:40:18.458Z",
  collected: "2026-10-17T01:40:18.458Z",
};
const checkedAt: Record<V15PickupStage, string> = {
  "awaiting-acceptance": "2026-10-17T01:39:31.300Z",
  queued: "2026-10-17T01:39:58.000Z",
  preparing: "2026-10-17T01:40:10.000Z",
  ready: "2026-10-17T01:40:21.000Z",
  collected: "2026-10-17T01:42:07.400Z",
};

export function v15PickupStatusBody(stage: V15PickupStage) {
  const collected = stage === "collected";
  const updatedAt = kitchenUpdatedAt[stage];
  return {
    schemaVersion: 1,
    status: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: collected
        ? "01a14786-0000-7000-8000-000000000003"
        : "01a14783-0000-7000-8000-000000000001",
      projectedAt: collected ? "2026-10-17T01:42:06.168Z" : "2026-10-17T01:39:10.676Z",
      freshnessStatus: "Fresh",
      order: {
        orderReference: v15PickupOrderReference,
        orderNumber: "17",
        orderType: "Pickup",
        canonicalPhase: collected ? "Fulfilled" : "Submitted",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: collected ? "Completed" : "Unavailable",
        fulfilledAt: collected ? "2026-10-17T01:42:05.183Z" : null,
        eta: null,
        submittedAt,
        batches: [
          {
            orderBatchReference: batchReference,
            submittedAt,
            items: [
              {
                orderItemReference: itemReference,
                displayName: "Flat White — Small (8 oz)",
                quantity: 1,
                lineTotal: { amountMinor: "542", currencyCode: "CAD" },
              },
            ],
          },
        ],
      },
      sources: {
        checkedAt: checkedAt[stage],
        kitchen:
          updatedAt === null
            ? null
            : {
                batches: [
                  {
                    orderBatchReference: batchReference,
                    status:
                      stage === "queued"
                        ? "Queued"
                        : stage === "preparing"
                          ? "InProgress"
                          : "Ready",
                    updatedAt,
                  },
                ],
              },
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-10-17T01:39:11.543Z",
            freshnessStatus: "Fresh",
            amount: { amountMinor: "542", currencyCode: "CAD" },
          },
        ],
        pickup: null,
        unpaidCancellation: null,
        itemPrices: [
          {
            orderItemReference: itemReference,
            subtotal: { amountMinor: "480", currencyCode: "CAD" },
            tax: { amountMinor: "62", currencyCode: "CAD" },
          },
        ],
        storeContact: {
          phone: "+15555550100",
          addressLines: ["100 Synthetic Street"],
          locality: "Toronto",
          regionCode: "ON",
          postalCode: "M5V 0A1",
        },
        contactDetails: "Stored",
      },
    },
  };
}
