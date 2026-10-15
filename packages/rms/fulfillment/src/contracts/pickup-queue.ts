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
  /** WP-2423 (DEC-PICKUP-COUNTER-CODE): five wrong codes locked code checks for this proof. */
  readonly codeChecksLocked?: true;
  readonly items: readonly {
    readonly fulfillmentItemReference: string;
    /** WP-2423 Q26: the Order item this pickup line fulfils (Kitchen remakes are matched on it). */
    readonly orderItemReference?: string;
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
