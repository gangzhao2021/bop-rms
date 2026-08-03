import type { Money } from "@rms/pricing";

export type PaymentReference = string & { readonly __paymentReference: unique symbol };
export type ProviderReference = string & { readonly __providerReference: unique symbol };
export type ProviderIdempotencyKey = string & {
  readonly __providerIdempotencyKey: unique symbol;
};
export type PaymentEvidenceDigest = string & { readonly __paymentEvidenceDigest: unique symbol };
export type SafeReasonCode = string & { readonly __safeReasonCode: unique symbol };

export const paymentMethods = ["OnlineCard", "TerminalCard", "TerminalInterac"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];
export const captureModes = ["Automatic", "ManualPreferred"] as const;
export type CaptureMode = (typeof captureModes)[number];
export const providerStatuses = [
  "RequiresCustomerAction",
  "Pending",
  "Authorized",
  "Captured",
  "Cancelled",
  "Failed",
  "Unknown",
] as const;
export type ProviderStatus = (typeof providerStatuses)[number];
export const providerFailureCodes = [
  "Declined",
  "AuthenticationRequired",
  "InvalidRequest",
  "Conflict",
  "RateLimited",
  "Unavailable",
  "Unknown",
] as const;
export type ProviderFailureCode = (typeof providerFailureCodes)[number];
export const retryDispositions = ["Never", "SameOperation", "NewOperation", "Unknown"] as const;
export type RetryDisposition = (typeof retryDispositions)[number];

export interface PaymentProviderContext {
  readonly provider: "Stripe";
  readonly environment: "Test" | "Live";
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly operationReference: PaymentReference;
}

interface MutationFields {
  readonly idempotencyKey: ProviderIdempotencyKey;
}

export interface CreateIntentRequest extends MutationFields {
  readonly operation: "CreateIntent";
  readonly purpose: "CreatePaymentIntent";
  readonly context: PaymentProviderContext;
  readonly paymentMethod: PaymentMethod;
  readonly captureMode: CaptureMode;
  readonly amount: Money;
}

export interface RetrieveIntentRequest {
  readonly operation: "RetrieveIntent";
  readonly purpose: "RetrievePaymentIntent";
  readonly context: PaymentProviderContext;
  readonly providerIntentReference: ProviderReference;
}

export interface CancelIntentRequest extends MutationFields {
  readonly operation: "CancelIntent";
  readonly purpose: "CancelPaymentIntent";
  readonly context: PaymentProviderContext;
  readonly providerIntentReference: ProviderReference;
}

export interface CaptureIntentRequest extends MutationFields {
  readonly operation: "CaptureIntent";
  readonly purpose: "CapturePaymentIntent";
  readonly context: PaymentProviderContext;
  readonly providerIntentReference: ProviderReference;
  readonly paymentMethod: "TerminalCard";
  readonly amount: Money;
}

export interface RefundPaymentRequest extends MutationFields {
  readonly operation: "RefundPayment";
  readonly purpose: "RefundPayment";
  readonly context: PaymentProviderContext;
  readonly providerIntentReference: ProviderReference;
  readonly originalPaymentMethod: PaymentMethod;
  readonly amount: Money;
}

export type PaymentProviderRequest =
  | CreateIntentRequest
  | RetrieveIntentRequest
  | CancelIntentRequest
  | CaptureIntentRequest
  | RefundPaymentRequest;

export interface PaymentProviderSnapshot {
  readonly kind: "Snapshot";
  readonly context: PaymentProviderContext;
  readonly providerIntentReference: ProviderReference;
  readonly providerTransactionReference: ProviderReference | null;
  readonly paymentMethod: PaymentMethod;
  readonly captureMode: CaptureMode;
  readonly status: ProviderStatus;
  readonly requestedAmount: Money;
  readonly authorizedAmount: Money;
  readonly capturedAmount: Money;
  readonly refundedAmount: Money;
  readonly observedAt: string;
  readonly evidenceDigest: PaymentEvidenceDigest;
}

export interface PaymentProviderFailure {
  readonly kind: "Failure";
  readonly context: PaymentProviderContext;
  readonly code: ProviderFailureCode;
  readonly retryDisposition: RetryDisposition;
  readonly safeReasonCode: SafeReasonCode;
}

export type PaymentProviderOutcome = PaymentProviderSnapshot | PaymentProviderFailure;

export interface PaymentProviderAdapter {
  createIntent(request: CreateIntentRequest): Promise<PaymentProviderOutcome>;
  retrieveIntent(request: RetrieveIntentRequest): Promise<PaymentProviderOutcome>;
  cancelIntent(request: CancelIntentRequest): Promise<PaymentProviderOutcome>;
  captureIntent(request: CaptureIntentRequest): Promise<PaymentProviderOutcome>;
  refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderOutcome>;
}

export const paymentProviderContractErrorCodes = [
  "PAYMENT_PROVIDER_INPUT_INVALID",
  "PAYMENT_PROVIDER_POLICY_VIOLATION",
  "PAYMENT_PROVIDER_STATE_INVALID",
] as const;
export type PaymentProviderContractErrorCode = (typeof paymentProviderContractErrorCodes)[number];

export class PaymentProviderContractError extends Error {
  readonly code: PaymentProviderContractErrorCode;

  constructor(code: PaymentProviderContractErrorCode) {
    super("payment provider contract input is invalid");
    this.name = "PaymentProviderContractError";
    this.code = code;
  }
}
