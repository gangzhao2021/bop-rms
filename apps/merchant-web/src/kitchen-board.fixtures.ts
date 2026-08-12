export const KITCHEN_REFS = Object.freeze({
  work: "018f0f58-767a-7f3b-a1d0-000000000401",
  ticket: "018f0f58-767a-7f3b-a1d0-000000000402",
  order: "018f0f58-767a-7f3b-a1d0-000000000403",
});
export function kitchenItemFixture() {
  return {
    workItemReference: KITCHEN_REFS.work,
    ticketReference: KITCHEN_REFS.ticket,
    orderReference: KITCHEN_REFS.order,
    stationLabel: "Hot line",
    displayName: "Mushroom rice bowl",
    status: "Queued",
    requiredQuantity: 2,
    completedQuantity: 0,
    createdAt: "2026-08-12T15:00:00.000Z",
    allergenCue: "ReviewRequired",
    exceptionStatus: "None",
  };
}
export function kitchenBoardFixture() {
  return {
    screenId: "KIT-KITCHEN-QUEUE",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    storeLabel: "Synthetic Training Store",
    projectedAt: "2026-08-12T15:12:00.000Z",
    freshnessStatus: "Fresh",
    operatorStatus: "Named",
    items: [kitchenItemFixture()],
  };
}
