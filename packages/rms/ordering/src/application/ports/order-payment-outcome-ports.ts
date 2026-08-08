import type { ConsumerTransaction } from "@bop/eventing";

import type { OrderConfirmedEnvelope } from "../../contracts/order-confirmed-event.js";
import type {
  OrderPaymentFailureRecord,
  OrderPaymentOutcomeDisposition,
  OrderPaymentOutcomeRecord,
  PaymentFailedEnvelope,
  PaymentOutcomeEnvelope,
  PaymentSucceededEnvelope,
} from "../../contracts/order-payment-outcome.js";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";

export interface StoredOrderPaymentOutcomeEffect {
  readonly record: OrderPaymentOutcomeRecord;
  readonly orderConfirmedEvent: OrderConfirmedEnvelope | null;
}

export interface OrderPaymentOutcomeConsumerPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: "ApplyPaymentOutcome";
      readonly purpose: "ApplyAuthoritativePaymentOutcome";
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly orderReference: OrderingReference;
      readonly paymentEventReference: OrderingReference;
      readonly observedAt: OrderingInstant;
    }): Promise<boolean>;
  };
  readonly source: {
    loadExact(input: {
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly orderReference: OrderingReference;
      readonly paymentTransactionReference: OrderingReference;
      readonly paymentIntentReference: OrderingReference;
      readonly paymentAttemptReference: OrderingReference;
      readonly paymentEventReference: OrderingReference;
      readonly paymentEvent: PaymentSucceededEnvelope;
    }): Promise<unknown | null>;
  };
  readonly outcomes: {
    loadByPaymentEvent(input: {
      readonly paymentEventReference: OrderingReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<StoredOrderPaymentOutcomeEffect | null>;
    commitSucceeded(input: {
      readonly sourceEvent: PaymentSucceededEnvelope;
      readonly disposition: OrderPaymentOutcomeDisposition;
      readonly orderConfirmedEvent: OrderConfirmedEnvelope | null;
      readonly transaction: ConsumerTransaction;
    }): Promise<{
      readonly status: "Created" | "AlreadyCommitted" | "Conflict";
      readonly effect: StoredOrderPaymentOutcomeEffect;
    }>;
    commitFailed(input: {
      readonly sourceEvent: PaymentFailedEnvelope;
      readonly failure: OrderPaymentFailureRecord;
      readonly transaction: ConsumerTransaction;
    }): Promise<{
      readonly status: "Created" | "AlreadyCommitted" | "Conflict";
      readonly effect: StoredOrderPaymentOutcomeEffect;
    }>;
  };
  readonly references: {
    generate(purpose: "OrderConfirmedEvent" | "PaymentFailureRecord"): string;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
}

export type OrderPaymentOutcomeAuthorizationEvent = PaymentOutcomeEnvelope;
