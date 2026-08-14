import type {
  DeliveryExceptionLifecycle,
  DeliveryExceptionReason,
  DeliveryExceptionSeverity,
} from "../domain/delivery-exception.js";
import type { DeliveryInstant, DeliveryReference } from "../domain/delivery-task.js";
export interface DeliveryExceptionQuery {
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly storeReference: DeliveryReference;
  readonly actorReference: DeliveryReference;
  readonly purpose: "DeliveryExceptionOperations" | "DeliverySupport";
  readonly permission: "fulfillment.delivery.exception.read";
  readonly status: DeliveryExceptionLifecycle | "All";
  readonly providerReference: DeliveryReference | null;
  readonly ownerReference: DeliveryReference | null;
  readonly overdue: boolean | null;
}
export interface DeliveryExceptionProjection {
  readonly projectionName: "delivery_exception_workbench_v1";
  readonly projectionVersion: 1;
  readonly asOfUtc: DeliveryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayAcknowledge: boolean;
    readonly mayAssign: boolean;
    readonly mayReroute: boolean;
    readonly mayRequestCancel: boolean;
    readonly mayHandoffSupport: boolean;
    readonly mayResolve: boolean;
  };
  readonly rows: readonly {
    readonly exceptionReference: DeliveryReference;
    readonly taskReference: DeliveryReference;
    readonly orderReference: DeliveryReference;
    readonly aggregateVersion: number;
    readonly lifecycle: DeliveryExceptionLifecycle;
    readonly severity: DeliveryExceptionSeverity;
    readonly reason: DeliveryExceptionReason;
    readonly ownerReference: DeliveryReference | null;
    readonly providerReference: DeliveryReference | null;
    readonly resolutionDeadline: DeliveryInstant;
    readonly overdue: boolean;
    readonly customerImpact: "None" | "Delayed" | "ActionRequired";
    readonly resolutionOrCompensationReference: DeliveryReference | null;
  }[];
}
