import type { DeliveryInstant, DeliveryReference } from "../domain/delivery-task.js";
export interface CustomerDeliveryTrackingQuery {
  readonly publicOrderReference: string;
  readonly guestSessionReference: DeliveryReference;
  readonly purpose: "CustomerDeliveryTracking";
  readonly permission: "customer.order.delivery.read";
}
export interface CustomerDeliveryTrackingProjection {
  readonly projectionName: "customer_delivery_tracking_v1";
  readonly projectionVersion: 1;
  readonly publicOrderReference: string;
  readonly asOfUtc: DeliveryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly status:
    | "Planning"
    | "CourierAssigned"
    | "PreparingPickup"
    | "OnTheWay"
    | "Delivered"
    | "AttentionNeeded"
    | "Cancelled";
  readonly eta: {
    readonly earliestUtc: DeliveryInstant;
    readonly latestUtc: DeliveryInstant;
  } | null;
  readonly handoffSummary:
    "NotStarted" | "StorePreparing" | "WithCourier" | "Complete" | "Exception";
  readonly proofSummary: "NotAvailable" | "Reviewing" | "Confirmed";
  readonly supportPath: string;
  readonly instructionUpdateAllowed: boolean;
  readonly instructionCutoffUtc: DeliveryInstant | null;
}
