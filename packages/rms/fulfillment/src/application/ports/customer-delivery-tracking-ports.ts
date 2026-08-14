import type {
  CustomerDeliveryTrackingProjection,
  CustomerDeliveryTrackingQuery,
} from "../../contracts/customer-delivery-tracking.js";
export interface CustomerDeliveryTrackingProjectionPort {
  load(query: CustomerDeliveryTrackingQuery): Promise<CustomerDeliveryTrackingProjection | null>;
}
