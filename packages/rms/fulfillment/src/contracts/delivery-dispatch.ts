import type {
  DeliveryAssignmentStatus,
  DeliveryExecutionStatus,
  DeliveryInstant,
  DeliveryReference,
  DeliveryTask,
} from "../domain/delivery-task.js";
export interface DeliveryDispatchQuery {
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly storeReference: DeliveryReference;
  readonly actorReference: DeliveryReference;
  readonly purpose: "DeliveryDispatch";
  readonly permission: "fulfillment.delivery.dispatch";
  readonly orderOrTaskReference: DeliveryReference | null;
  readonly executionStatus: DeliveryExecutionStatus | "All";
  readonly assignmentStatus: DeliveryAssignmentStatus | "All";
  readonly zoneReference: DeliveryReference | null;
  readonly providerReference: DeliveryReference | null;
  readonly overdue: boolean | null;
  readonly exceptionOnly: boolean;
}
export interface DeliveryDispatchProjection {
  readonly projectionName: "delivery_task_queue_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly storeReference: DeliveryReference;
  readonly asOfUtc: DeliveryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayAssign: boolean;
    readonly mayAccept: boolean;
    readonly mayStart: boolean;
    readonly mayReassign: boolean;
    readonly mayOpenException: boolean;
  };
  readonly rows: readonly {
    readonly taskReference: DeliveryReference;
    readonly orderReference: DeliveryReference;
    readonly aggregateVersion: number;
    readonly executionStatus: DeliveryExecutionStatus;
    readonly assignmentStatus: DeliveryAssignmentStatus;
    readonly confirmedWindowReference: DeliveryReference;
    readonly zoneReference: DeliveryReference;
    readonly providerOrCourierReference: DeliveryReference | null;
    readonly handoffState: "NotReady" | "Ready" | "HandedOff";
    readonly ageSeconds: number;
    readonly overdue: boolean;
    readonly openExceptionCount: number;
  }[];
}
export interface CreateDeliveryTaskCommand {
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly storeReference: DeliveryReference;
  readonly actorReference: DeliveryReference;
  readonly purpose: "DeliveryTaskCreation";
  readonly permission: "fulfillment.delivery.create";
  readonly operationReference: DeliveryReference;
  readonly occurredAt: DeliveryInstant;
  readonly fulfillmentReference: DeliveryReference;
  readonly taskReference: DeliveryReference;
}
export interface DeliveryTaskCreationRecord {
  readonly operationReference: DeliveryReference;
  readonly intentHash: string;
  readonly command: CreateDeliveryTaskCommand;
  readonly task: DeliveryTask;
  readonly auditReference: DeliveryReference;
  readonly outcome: "Created" | "AlreadyCreated";
}
