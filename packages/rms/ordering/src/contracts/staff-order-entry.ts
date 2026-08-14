import type { OrderingInstant, OrderingReference } from "../domain/cart.js";

export type StaffOrderEntryAction =
  | "CreateCart"
  | "ConfigureItem"
  | "Requote"
  | "AttachDiningSession"
  | "RecordAllergenReview"
  | "Submit"
  | "StartTerminalPayment";

export interface StaffOrderEntryCommand {
  readonly tenantReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly actorReference: OrderingReference;
  readonly purpose: "StaffOrderEntry";
  readonly operationReference: OrderingReference;
  readonly observedAt: OrderingInstant;
  readonly action: StaffOrderEntryAction;
  readonly sourceChannel: "Pos";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StaffOrderEntryReceipt {
  readonly operationReference: OrderingReference;
  readonly intentHash: string;
  readonly action: StaffOrderEntryAction;
  readonly outcome: "Applied" | "AlreadyApplied";
  readonly sharedContract:
    | "Ordering.Cart.v1"
    | "Pricing.Quote.v1"
    | "Dining.SessionEligibility.v1"
    | "FoodSafety.AllergenReview.v1"
    | "Ordering.Submit.v1"
    | "Payment.TerminalStart.v1";
  readonly cartReference: OrderingReference | null;
  readonly cartVersion: number | null;
  readonly quoteReference: OrderingReference | null;
  readonly orderReference: OrderingReference | null;
  readonly batchReference: OrderingReference | null;
  readonly paymentAttemptReference: OrderingReference | null;
  readonly terminalStatus: "NotStarted" | "Pending";
  readonly allergenReadiness: "ReadyNoReviewRequired" | "ReviewCurrent";
  readonly sourceChannel: "Pos";
  readonly createdActorReference: OrderingReference;
  readonly submittedActorReference: OrderingReference | null;
  readonly auditReference: OrderingReference;
}

export class StaffOrderEntryError extends Error {
  constructor(
    readonly code:
      | "STAFF_ORDER_ENTRY_INVALID"
      | "STAFF_ORDER_ENTRY_PERMISSION_DENIED"
      | "STAFF_ORDER_ENTRY_IDEMPOTENCY_CONFLICT"
      | "STAFF_ORDER_ENTRY_ALLERGEN_REVIEW_REQUIRED"
      | "STAFF_ORDER_ENTRY_SHARED_CONTRACT_REJECTED"
      | "STAFF_ORDER_ENTRY_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Staff Order Entry command failed");
    this.name = "StaffOrderEntryError";
  }
}
