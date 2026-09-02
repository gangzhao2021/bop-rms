import type { DeliveryInstant, DeliveryReference } from "../domain/delivery-task.js";
export interface DeliveryDetailQuery {
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly storeReference: DeliveryReference;
  readonly actorReference: DeliveryReference;
  readonly taskReference: DeliveryReference;
  readonly purpose: "DeliveryOperations" | "DeliverySupport" | "DeliveryAudit";
  readonly permission: "fulfillment.delivery.read";
}
export interface DeliveryDetailProjection {
  readonly projectionName: "delivery_task_detail_v1";
  readonly projectionVersion: 1;
  readonly taskReference: DeliveryReference;
  readonly orderReference: DeliveryReference;
  readonly aggregateVersion: number;
  readonly asOfUtc: DeliveryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly executionStatus: string;
  readonly assignmentStatus: string;
  readonly maskedAddress: string;
  readonly maskedContact: string;
  readonly requestedWindow: {
    readonly startUtc: DeliveryInstant;
    readonly endUtc: DeliveryInstant;
  };
  readonly confirmedWindow: {
    readonly startUtc: DeliveryInstant;
    readonly endUtc: DeliveryInstant;
  };
  readonly feeMinor: number;
  readonly currency: string;
  readonly providerOrCourierReference: DeliveryReference | null;
  readonly proofReferences: readonly DeliveryReference[];
  readonly contactAttemptReferences: readonly DeliveryReference[];
  readonly timelineReferences: readonly DeliveryReference[];
  readonly permissions: {
    readonly mayRevise: boolean;
    readonly mayDispatch: boolean;
    readonly mayCancel: boolean;
    readonly mayReassign: boolean;
    readonly mayRecordException: boolean;
  };
}
