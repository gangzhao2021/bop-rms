import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface PaymentSucceededPayload extends JsonObject {
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  readonly orderReference: string;
  readonly amountMinor: string;
  readonly currencyCode: "CAD";
  readonly evidenceKind: "Captured";
  readonly terminalOccurredAt: string;
}

export interface PaymentFailedPayload extends JsonObject {
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  readonly orderReference: string;
  readonly reason: "Declined" | "AuthenticationRequired" | "Cancelled" | "ProviderRejected";
  readonly retryDisposition: "Never" | "SameOperation" | "NewOperation" | "Unknown";
  readonly terminalOccurredAt: string;
}

export type PaymentSucceededEnvelope = DomainEventEnvelope<PaymentSucceededPayload>;
export type PaymentFailedEnvelope = DomainEventEnvelope<PaymentFailedPayload>;
export type PaymentTerminalEnvelope = PaymentSucceededEnvelope | PaymentFailedEnvelope;
