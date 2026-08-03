import type { AppendAuditRecordInput } from "@bop/audit";
import type { OrderCreatedEnvelope } from "../../contracts/order-created-event.js";
import type { GuestSession } from "@bop/identity";
import type { StoreBusinessDateResolution } from "@rms/store";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";
import type { CheckoutValidationEvidence } from "../../domain/checkout-validation.js";
import type { CreateOrderResult, OrderCreationRecord } from "../../domain/order-creation.js";
export interface OrderCreationSourceLine {
  readonly cartItemReference: unknown;
  readonly catalog: unknown;
  readonly pricing: unknown;
}

export interface OrderCreationPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: "CreateOrder";
      readonly submissionReference: OrderingReference;
      readonly cartReference: OrderingReference;
      readonly observedAt: OrderingInstant;
    }): Promise<{ readonly guestSession: GuestSession } | null>;
  };
  readonly audit: {
    create(input: {
      readonly order: OrderCreationRecord["order"];
      readonly submissionReference: OrderingReference;
      readonly observedAt: OrderingInstant;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly checkout: {
    validate(input: {
      readonly validationReference: OrderingReference;
      readonly cartReference: OrderingReference;
      readonly expectedCartVersion: number;
      readonly quoteReference: OrderingReference;
      readonly requestedAt: OrderingInstant;
    }): Promise<CheckoutValidationEvidence>;
  };
  readonly source: {
    load(input: { readonly evidence: CheckoutValidationEvidence }): Promise<{
      readonly cart: unknown;
      readonly lines: readonly OrderCreationSourceLine[];
    }>;
  };
  readonly businessDate: {
    resolve(input: {
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly occurredAt: OrderingInstant;
    }): Promise<StoreBusinessDateResolution>;
  };
  readonly references: {
    generate(
      purpose: "CheckoutValidation" | "Order" | "OrderBatch" | "OrderItem" | "Event",
    ): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveSubmission(submissionReference: OrderingReference): Promise<OrderCreationRecord | null>;
    commit(input: {
      readonly record: Omit<OrderCreationRecord, "orderNumberAllocation">;
      readonly businessDateResolution: StoreBusinessDateResolution;
      readonly audit: AppendAuditRecordInput;
      readonly event: OrderCreatedEnvelope;
    }): Promise<OrderCreationRecord>;
  };
}

export type OrderCreationCommandResult = CreateOrderResult;
