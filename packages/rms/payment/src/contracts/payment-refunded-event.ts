import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

export interface PaymentRefundedPayload extends JsonObject {
  readonly refundReference: string;
  readonly compensationCaseReference: string;
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  readonly orderReference: string;
  readonly amountMinor: string;
  readonly currencyCode: "CAD";
  readonly refundKind: "PaidWithoutFulfillableOrderCompensation";
  readonly providerConfirmedAt: string;
}

export type PaymentRefundedEnvelope = DomainEventEnvelope<PaymentRefundedPayload>;
