import type { ProviderEventReceiptCommand } from "../../contracts/delivery-provider.js";
import type { ProviderEventEnvelope } from "../../domain/delivery-provider.js";
import type { DeliveryReference } from "../../domain/delivery-task.js";
export interface ProviderEventEnvelopePort {
  find(
    providerAccountReference: DeliveryReference,
    providerEventReference: DeliveryReference,
  ): Promise<ProviderEventEnvelope | null>;
  append(command: ProviderEventReceiptCommand): Promise<void>;
}
export interface ProviderStatusMappingPort {
  mapping(
    providerAccountReference: DeliveryReference,
    mappingVersionReference: DeliveryReference,
  ): Promise<Readonly<Record<string, unknown>>>;
}
export interface ProviderExceptionPort {
  open(input: {
    readonly providerAccountReference: DeliveryReference;
    readonly envelopeReference: DeliveryReference;
    readonly reason: "UNKNOWN_STATUS" | "TERMINAL_CONFLICT";
  }): Promise<DeliveryReference>;
}
