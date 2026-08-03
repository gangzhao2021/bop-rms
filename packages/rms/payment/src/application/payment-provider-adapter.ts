import { createMoney, type Money } from "@rms/pricing";

import {
  captureModes,
  paymentMethods,
  PaymentProviderContractError,
  providerFailureCodes,
  providerStatuses,
  retryDispositions,
  type CancelIntentRequest,
  type CaptureIntentRequest,
  type CreateIntentRequest,
  type PaymentEvidenceDigest,
  type PaymentMethod,
  type PaymentProviderContext,
  type PaymentProviderFailure,
  type PaymentProviderOutcome,
  type PaymentProviderSnapshot,
  type PaymentReference,
  type ProviderIdempotencyKey,
  type ProviderReference,
  type RefundPaymentRequest,
  type RetrieveIntentRequest,
  type SafeReasonCode,
} from "../contracts/payment-provider-adapter.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const providerReference = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{6,126}[A-Za-z0-9])$/u;
const idempotencyKey = /^[A-Za-z0-9](?:[A-Za-z0-9:_-]{14,198}[A-Za-z0-9])$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const safeReasonCode = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

function fail(
  code:
    | "PAYMENT_PROVIDER_INPUT_INVALID"
    | "PAYMENT_PROVIDER_POLICY_VIOLATION"
    | "PAYMENT_PROVIDER_STATE_INVALID",
): never {
  throw new PaymentProviderContractError(code);
}

function exact(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  )
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return value as T;
}

export function parsePaymentReference(value: unknown): PaymentReference {
  if (typeof value !== "string" || !uuidV7.test(value)) fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return value as PaymentReference;
}

export function parseProviderReference(value: unknown): ProviderReference {
  if (typeof value !== "string" || !providerReference.test(value))
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return value as ProviderReference;
}

export function parseProviderIdempotencyKey(value: unknown): ProviderIdempotencyKey {
  if (typeof value !== "string" || !idempotencyKey.test(value))
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return value as ProviderIdempotencyKey;
}

function parseMoney(value: unknown, positive: boolean): Money {
  let money: Money;
  try {
    money = createMoney(value as Money);
  } catch {
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  }
  if (money.currencyCode !== "CAD" || (positive ? money.amountMinor <= 0n : money.amountMinor < 0n))
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return money;
}

export function createPaymentProviderContext(
  input: PaymentProviderContext,
): PaymentProviderContext {
  exact(input, [
    "provider",
    "environment",
    "brandReference",
    "storeReference",
    "paymentAttemptReference",
    "operationReference",
  ]);
  if (input.provider !== "Stripe") fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return Object.freeze({
    provider: "Stripe",
    environment: oneOf(input.environment, ["Test", "Live"] as const),
    brandReference: parsePaymentReference(input.brandReference),
    storeReference: parsePaymentReference(input.storeReference),
    paymentAttemptReference: parsePaymentReference(input.paymentAttemptReference),
    operationReference: parsePaymentReference(input.operationReference),
  });
}

function expectedCaptureMode(method: PaymentMethod): "Automatic" | "ManualPreferred" {
  return method === "OnlineCard" ? "Automatic" : "ManualPreferred";
}

export function createCreateIntentRequest(input: CreateIntentRequest): CreateIntentRequest {
  exact(input, [
    "operation",
    "purpose",
    "context",
    "idempotencyKey",
    "paymentMethod",
    "captureMode",
    "amount",
  ]);
  if (input.operation !== "CreateIntent" || input.purpose !== "CreatePaymentIntent")
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  const method = oneOf(input.paymentMethod, paymentMethods);
  const mode = oneOf(input.captureMode, captureModes);
  if (mode !== expectedCaptureMode(method)) fail("PAYMENT_PROVIDER_POLICY_VIOLATION");
  return Object.freeze({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context: createPaymentProviderContext(input.context),
    idempotencyKey: parseProviderIdempotencyKey(input.idempotencyKey),
    paymentMethod: method,
    captureMode: mode,
    amount: parseMoney(input.amount, true),
  });
}

export function createRetrieveIntentRequest(input: RetrieveIntentRequest): RetrieveIntentRequest {
  exact(input, ["operation", "purpose", "context", "providerIntentReference"]);
  if (input.operation !== "RetrieveIntent" || input.purpose !== "RetrievePaymentIntent")
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return Object.freeze({
    operation: "RetrieveIntent",
    purpose: "RetrievePaymentIntent",
    context: createPaymentProviderContext(input.context),
    providerIntentReference: parseProviderReference(input.providerIntentReference),
  });
}

export function createCancelIntentRequest(input: CancelIntentRequest): CancelIntentRequest {
  exact(input, ["operation", "purpose", "context", "idempotencyKey", "providerIntentReference"]);
  if (input.operation !== "CancelIntent" || input.purpose !== "CancelPaymentIntent")
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return Object.freeze({
    operation: "CancelIntent",
    purpose: "CancelPaymentIntent",
    context: createPaymentProviderContext(input.context),
    idempotencyKey: parseProviderIdempotencyKey(input.idempotencyKey),
    providerIntentReference: parseProviderReference(input.providerIntentReference),
  });
}

export function createCaptureIntentRequest(input: CaptureIntentRequest): CaptureIntentRequest {
  exact(input, [
    "operation",
    "purpose",
    "context",
    "idempotencyKey",
    "providerIntentReference",
    "paymentMethod",
    "amount",
  ]);
  if (
    input.operation !== "CaptureIntent" ||
    input.purpose !== "CapturePaymentIntent" ||
    input.paymentMethod !== "TerminalCard"
  )
    fail("PAYMENT_PROVIDER_POLICY_VIOLATION");
  return Object.freeze({
    operation: "CaptureIntent",
    purpose: "CapturePaymentIntent",
    context: createPaymentProviderContext(input.context),
    idempotencyKey: parseProviderIdempotencyKey(input.idempotencyKey),
    providerIntentReference: parseProviderReference(input.providerIntentReference),
    paymentMethod: "TerminalCard",
    amount: parseMoney(input.amount, true),
  });
}

export function createRefundPaymentRequest(input: RefundPaymentRequest): RefundPaymentRequest {
  exact(input, [
    "operation",
    "purpose",
    "context",
    "idempotencyKey",
    "providerIntentReference",
    "originalPaymentMethod",
    "amount",
  ]);
  if (input.operation !== "RefundPayment" || input.purpose !== "RefundPayment")
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return Object.freeze({
    operation: "RefundPayment",
    purpose: "RefundPayment",
    context: createPaymentProviderContext(input.context),
    idempotencyKey: parseProviderIdempotencyKey(input.idempotencyKey),
    providerIntentReference: parseProviderReference(input.providerIntentReference),
    originalPaymentMethod: oneOf(input.originalPaymentMethod, paymentMethods),
    amount: parseMoney(input.amount, true),
  });
}

function amountIsZero(amount: Money): boolean {
  return amount.amountMinor === 0n;
}

function validateSnapshotState(snapshot: PaymentProviderSnapshot): void {
  const requested = snapshot.requestedAmount.amountMinor;
  const authorized = snapshot.authorizedAmount.amountMinor;
  const captured = snapshot.capturedAmount.amountMinor;
  const refunded = snapshot.refundedAmount.amountMinor;
  if (authorized > requested || captured > authorized || refunded > captured)
    fail("PAYMENT_PROVIDER_STATE_INVALID");
  if (
    (["RequiresCustomerAction", "Pending", "Cancelled", "Failed", "Unknown"] as const).includes(
      snapshot.status as "RequiresCustomerAction",
    ) &&
    (!amountIsZero(snapshot.authorizedAmount) ||
      !amountIsZero(snapshot.capturedAmount) ||
      !amountIsZero(snapshot.refundedAmount))
  )
    fail("PAYMENT_PROVIDER_STATE_INVALID");
  if (
    snapshot.status === "Authorized" &&
    (snapshot.paymentMethod !== "TerminalCard" ||
      snapshot.captureMode !== "ManualPreferred" ||
      authorized <= 0n ||
      captured !== 0n ||
      refunded !== 0n)
  )
    fail("PAYMENT_PROVIDER_STATE_INVALID");
  if (
    snapshot.status === "Captured" &&
    (captured <= 0n ||
      (snapshot.paymentMethod !== "TerminalCard" &&
        (authorized !== requested || captured !== requested)))
  )
    fail("PAYMENT_PROVIDER_STATE_INVALID");
  if (snapshot.paymentMethod === "TerminalInterac" && snapshot.status === "Authorized")
    fail("PAYMENT_PROVIDER_STATE_INVALID");
}

export function createPaymentProviderSnapshot(
  input: PaymentProviderSnapshot,
): PaymentProviderSnapshot {
  exact(input, [
    "kind",
    "context",
    "providerIntentReference",
    "providerTransactionReference",
    "paymentMethod",
    "captureMode",
    "status",
    "requestedAmount",
    "authorizedAmount",
    "capturedAmount",
    "refundedAmount",
    "observedAt",
    "evidenceDigest",
  ]);
  if (input.kind !== "Snapshot") fail("PAYMENT_PROVIDER_INPUT_INVALID");
  if (
    typeof input.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.observedAt) ||
    Number.isNaN(Date.parse(input.observedAt)) ||
    new Date(input.observedAt).toISOString() !== input.observedAt ||
    typeof input.evidenceDigest !== "string" ||
    !digest.test(input.evidenceDigest)
  )
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  const method = oneOf(input.paymentMethod, paymentMethods);
  const mode = oneOf(input.captureMode, captureModes);
  if (mode !== expectedCaptureMode(method)) fail("PAYMENT_PROVIDER_STATE_INVALID");
  const snapshot = Object.freeze({
    kind: "Snapshot" as const,
    context: createPaymentProviderContext(input.context),
    providerIntentReference: parseProviderReference(input.providerIntentReference),
    providerTransactionReference:
      input.providerTransactionReference === null
        ? null
        : parseProviderReference(input.providerTransactionReference),
    paymentMethod: method,
    captureMode: mode,
    status: oneOf(input.status, providerStatuses),
    requestedAmount: parseMoney(input.requestedAmount, true),
    authorizedAmount: parseMoney(input.authorizedAmount, false),
    capturedAmount: parseMoney(input.capturedAmount, false),
    refundedAmount: parseMoney(input.refundedAmount, false),
    observedAt: input.observedAt,
    evidenceDigest: input.evidenceDigest as PaymentEvidenceDigest,
  });
  validateSnapshotState(snapshot);
  if (snapshot.status === "Captured" && snapshot.providerTransactionReference === null)
    fail("PAYMENT_PROVIDER_STATE_INVALID");
  return snapshot;
}

export function createPaymentProviderFailure(
  input: PaymentProviderFailure,
): PaymentProviderFailure {
  exact(input, ["kind", "context", "code", "retryDisposition", "safeReasonCode"]);
  if (
    input.kind !== "Failure" ||
    typeof input.safeReasonCode !== "string" ||
    input.safeReasonCode.length > 64 ||
    !safeReasonCode.test(input.safeReasonCode)
  )
    fail("PAYMENT_PROVIDER_INPUT_INVALID");
  return Object.freeze({
    kind: "Failure",
    context: createPaymentProviderContext(input.context),
    code: oneOf(input.code, providerFailureCodes),
    retryDisposition: oneOf(input.retryDisposition, retryDispositions),
    safeReasonCode: input.safeReasonCode as SafeReasonCode,
  });
}

export function parsePaymentProviderOutcome(input: unknown): PaymentProviderOutcome {
  if (input === null || typeof input !== "object") fail("PAYMENT_PROVIDER_INPUT_INVALID");
  const kind = Object.getOwnPropertyDescriptor(input, "kind");
  if (kind === undefined || !("value" in kind)) fail("PAYMENT_PROVIDER_INPUT_INVALID");
  if (kind.value === "Snapshot")
    return createPaymentProviderSnapshot(input as PaymentProviderSnapshot);
  if (kind.value === "Failure")
    return createPaymentProviderFailure(input as PaymentProviderFailure);
  fail("PAYMENT_PROVIDER_INPUT_INVALID");
}
