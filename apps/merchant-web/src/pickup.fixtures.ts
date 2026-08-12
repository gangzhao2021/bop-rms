export const PICKUP_REFS = Object.freeze({
  fulfillment: "018f0f58-767a-7f3b-a1d0-000000000501",
  order: "018f0f58-767a-7f3b-a1d0-000000000502",
});
export function pickupQueueFixture() {
  return {
    screenId: "FUL-PICKUP-QUEUE",
    projectionName: "fulfillment_pickup_queue_v1",
    projectionVersion: 1,
    storeLabel: "Synthetic Training Store",
    projectedAt: "2026-08-12T15:20:00.000Z",
    freshnessStatus: "Fresh",
    items: [
      {
        fulfillmentReference: PICKUP_REFS.fulfillment,
        orderReference: PICKUP_REFS.order,
        publicOrderNumber: "ORD-1001",
        phase: "Ready",
        readyAt: "2026-08-12T15:00:00.000Z",
        proofReadiness: "Ready",
        stagingLocation: "Shelf A",
        claimStatus: "Unclaimed",
        exceptionStatus: "None",
        packageCount: 2,
        allergenCue: "Present",
      },
    ],
  };
}
