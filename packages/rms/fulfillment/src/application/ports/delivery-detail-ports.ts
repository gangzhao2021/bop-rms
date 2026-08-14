import type {
  DeliveryDetailProjection,
  DeliveryDetailQuery,
} from "../../contracts/delivery-detail.js";
import type { DeliveryDetail } from "../../domain/delivery-detail.js";
import type { DeliveryReference } from "../../domain/delivery-task.js";
export interface DeliveryDetailRepository {
  load(taskReference: DeliveryReference): Promise<DeliveryDetail | null>;
  append(detail: DeliveryDetail, expectedVersion: number): Promise<void>;
}
export interface DeliveryDetailProjectionPort {
  load(query: DeliveryDetailQuery): Promise<DeliveryDetailProjection | null>;
}
export interface DeliveryDetailAuditPort {
  append(input: {
    readonly taskReference: DeliveryReference;
    readonly actorReference: DeliveryReference;
    readonly outcome: "Accepted" | "Rejected";
  }): Promise<DeliveryReference>;
}
