/** Current owner read, not a persisted asynchronous projection. Cursor is Store-scoped by caller. */
export interface PickupQueueReadItem {
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly phase: "Ready" | "InProgress" | "Completed";
  readonly aggregateVersion: bigint;
  readonly readyAt: string;
  readonly publicOrderReference: string | null;
  readonly proof: {
    readonly kind: "Opaque" | "HumanCode";
    readonly generation: number;
    readonly expiresAt: string;
  } | null;
  readonly items: readonly {
    readonly fulfillmentItemReference: string;
    readonly orderedQuantity: number;
    readonly readyQuantity: number;
    readonly handedOverQuantity: number;
  }[];
}
export interface PickupQueueReadPage {
  readonly source: "CurrentFulfillment";
  readonly observedAt: string;
  readonly items: readonly PickupQueueReadItem[];
  readonly nextAfterFulfillmentReference: string | null;
}
