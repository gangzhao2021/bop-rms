import type {
  CreateDeliveryTaskCommand,
  DeliveryDispatchProjection,
  DeliveryDispatchQuery,
  DeliveryTaskCreationRecord,
} from "../../contracts/delivery-dispatch.js";
import type { DeliveryReference } from "../../domain/delivery-task.js";
export interface DeliveryDispatchPorts {
  readonly authorization: {
    authorize(input: CreateDeliveryTaskCommand | DeliveryDispatchQuery): Promise<{
      authorized: boolean;
      mayAssign: boolean;
      mayAccept: boolean;
      mayStart: boolean;
      mayReassign: boolean;
      mayOpenException: boolean;
    } | null>;
  };
  readonly fulfillmentSource: {
    resolve(command: CreateDeliveryTaskCommand): Promise<{
      fulfillmentType: "Delivery" | "Pickup";
      fulfillmentStatus: "Planned" | "Pending" | "Cancelled";
      orderReference: DeliveryReference;
      addressSnapshotReference: DeliveryReference | null;
      confirmedWindowReference: DeliveryReference | null;
      capacityAllocationReference: DeliveryReference | null;
      requirementsReference: DeliveryReference | null;
    }>;
  };
  readonly repository: {
    resolveOperation(reference: DeliveryReference): Promise<DeliveryTaskCreationRecord | null>;
    create(record: DeliveryTaskCreationRecord): Promise<DeliveryTaskCreationRecord>;
  };
  readonly projections: {
    queue(query: DeliveryDispatchQuery): Promise<DeliveryDispatchProjection>;
  };
  readonly audit: { create(command: CreateDeliveryTaskCommand): Promise<DeliveryReference> };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
