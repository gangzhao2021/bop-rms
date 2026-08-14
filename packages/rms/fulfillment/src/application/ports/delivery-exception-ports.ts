import type {
  DeliveryExceptionProjection,
  DeliveryExceptionQuery,
} from "../../contracts/delivery-exception.js";
import type { DeliveryCompletionException } from "../../domain/delivery-exception.js";
import type { DeliveryReference } from "../../domain/delivery-task.js";
export interface DeliveryExceptionRepository {
  load(exceptionReference: DeliveryReference): Promise<DeliveryCompletionException | null>;
  append(exception: DeliveryCompletionException, expectedVersion: number): Promise<void>;
}
export interface DeliveryExceptionProjectionPort {
  load(query: DeliveryExceptionQuery): Promise<DeliveryExceptionProjection>;
}
export interface DeliverySupportHandoffPort {
  create(input: {
    readonly exceptionReference: DeliveryReference;
    readonly orderReference: DeliveryReference;
    readonly customerImpact: "None" | "Delayed" | "ActionRequired";
    readonly evidenceReferences: readonly DeliveryReference[];
  }): Promise<DeliveryReference>;
}
