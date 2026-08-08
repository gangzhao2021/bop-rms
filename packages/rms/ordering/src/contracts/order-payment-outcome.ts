import type { DomainEventEnvelope, JsonObject } from "@bop/eventing";

import type { OrderingHash, OrderingInstant, OrderingReference } from "../domain/cart.js";

export const paymentFailureReasons = [
  "Declined",
  "AuthenticationRequired",
  "Cancelled",
  "ProviderRejected",
] as const;
export type PaymentFailureReason = (typeof paymentFailureReasons)[number];

export const paymentRetryDispositions = [
  "Never",
  "SameOperation",
  "NewOperation",
  "Unknown",
] as const;
export type PaymentRetryDisposition = (typeof paymentRetryDispositions)[number];

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
  readonly reason: PaymentFailureReason;
  readonly retryDisposition: PaymentRetryDisposition;
  readonly terminalOccurredAt: string;
}

export type PaymentSucceededEnvelope = DomainEventEnvelope<PaymentSucceededPayload> & {
  readonly eventType: "PaymentSucceeded";
};
export type PaymentFailedEnvelope = DomainEventEnvelope<PaymentFailedPayload> & {
  readonly eventType: "PaymentFailed";
};
export type PaymentOutcomeEnvelope = PaymentSucceededEnvelope | PaymentFailedEnvelope;

export interface OrderPaymentOutcomeDispositionBase {
  readonly dispositionReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  readonly paymentTransactionReference: OrderingReference;
  readonly paymentIntentReference: OrderingReference;
  readonly paymentAttemptReference: OrderingReference;
  readonly paymentEventReference: OrderingReference;
  readonly sourceVersion: number;
  readonly sourceCheckpoint: OrderingReference;
  readonly sourceDigest: OrderingHash;
  readonly evaluatedAt: OrderingInstant;
}

export interface ConfirmedOrderPaymentOutcomeDisposition extends OrderPaymentOutcomeDispositionBase {
  readonly disposition: "Confirmed";
  readonly confirmationReference: OrderingReference;
  readonly sourceSnapshotDigest: OrderingHash;
  readonly confirmedAt: OrderingInstant;
}

export interface AwaitingOrderPaymentOutcomeDisposition extends OrderPaymentOutcomeDispositionBase {
  readonly disposition: "AwaitingAcceptance";
  readonly reason: "OrderAcceptancePending";
}

export interface PaidWithoutFulfillableOrderDisposition extends OrderPaymentOutcomeDispositionBase {
  readonly disposition: "PaidWithoutFulfillableOrder";
  readonly reason: "CapacityExpired" | "SubmissionCancelled" | "OrderNoLongerFulfillable";
  readonly kitchenReleaseDisposition: "Blocked";
}

export type OrderPaymentOutcomeDisposition =
  | ConfirmedOrderPaymentOutcomeDisposition
  | AwaitingOrderPaymentOutcomeDisposition
  | PaidWithoutFulfillableOrderDisposition;

export interface OrderPaymentFailureRecord {
  readonly failureRecordReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly paymentTransactionReference: OrderingReference;
  readonly paymentIntentReference: OrderingReference;
  readonly paymentAttemptReference: OrderingReference;
  readonly paymentEventReference: OrderingReference;
  readonly reason: PaymentFailureReason;
  readonly retryDisposition: PaymentRetryDisposition;
  readonly terminalOccurredAt: OrderingInstant;
  readonly eventDigest: OrderingHash;
}

export type OrderPaymentOutcomeRecord = OrderPaymentOutcomeDisposition | OrderPaymentFailureRecord;

export type OrderPaymentOutcomeResult =
  | {
      readonly status: "OrderConfirmed";
      readonly disposition: ConfirmedOrderPaymentOutcomeDisposition;
      readonly orderConfirmedEventReference: OrderingReference;
    }
  | {
      readonly status: "AwaitingOrderAcceptance";
      readonly disposition: AwaitingOrderPaymentOutcomeDisposition;
    }
  | {
      readonly status: "CompensationRequired";
      readonly disposition: PaidWithoutFulfillableOrderDisposition;
    }
  | {
      readonly status: "PaymentFailedRecorded";
      readonly failure: OrderPaymentFailureRecord;
    };
