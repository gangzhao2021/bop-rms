import type {
  ProviderEventEnvelope,
  ProviderJobCreation,
  ProviderStatusResult,
} from "../domain/delivery-provider.js";
import type { DeliveryReference } from "../domain/delivery-task.js";
export interface ProviderEventReceiptCommand {
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly providerAccountReference: DeliveryReference;
  readonly purpose: "ProviderWebhookReceipt";
  readonly permission: "fulfillment.delivery.provider_event.receive";
  readonly envelope: ProviderEventEnvelope;
}
export interface ProviderEventReceipt {
  readonly idempotencyKey: `${string}:${string}`;
  readonly envelope: ProviderEventEnvelope;
  readonly statusResult: ProviderStatusResult;
  readonly acknowledgement: "Accepted" | "Duplicate";
}
export interface ProviderCreateReconciliation {
  readonly creation: ProviderJobCreation;
  readonly mayRetryCreate: false;
  readonly pollingRequired: boolean;
}
