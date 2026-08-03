import { createMoney, type Money } from "@rms/pricing";

import type {
  CaptureMode,
  PaymentMethod,
  PaymentReference,
  ProviderReference,
  ProviderStatus,
} from "../contracts/payment-provider-adapter.js";
import {
  captureModes,
  paymentMethods,
  providerStatuses,
} from "../contracts/payment-provider-adapter.js";
import { parsePaymentReference, parseProviderReference } from "./payment-provider-adapter.js";
import { parsePaymentInstant, type PaymentInstant } from "./payment-intent-creation.js";

export const paymentReconciliationOutcomes = [
  "Matched",
  "Healed",
  "Unresolved",
  "Unavailable",
  "Difference",
] as const;
export type PaymentReconciliationOutcome = (typeof paymentReconciliationOutcomes)[number];
export const paymentReconciliationDifferenceReasons = [
  "StateMismatch",
  "AmountMismatch",
  "RefundMismatch",
  "TerminalConflict",
] as const;
export type PaymentReconciliationDifferenceReason =
  (typeof paymentReconciliationDifferenceReasons)[number];
export type PaymentReconciliationMode = "Operational" | "DailySettlement";

export const paymentReconciliationErrorCodes = [
  "PAYMENT_RECONCILIATION_INPUT_INVALID",
  "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  "PAYMENT_RECONCILIATION_LEASE_UNAVAILABLE",
  "PAYMENT_RECONCILIATION_RUN_CONFLICT",
  "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
  "PAYMENT_RECONCILIATION_NOT_FOUND",
] as const;
export type PaymentReconciliationErrorCode = (typeof paymentReconciliationErrorCodes)[number];

export class PaymentReconciliationError extends Error {
  readonly code: PaymentReconciliationErrorCode;
  constructor(code: PaymentReconciliationErrorCode) {
    super("payment reconciliation is unavailable");
    this.name = "PaymentReconciliationError";
    this.code = code;
  }
}

function invalid(): never {
  throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return invalid();
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof PaymentReconciliationError) throw error;
    return invalid();
  }
}

function money(value: unknown, positive = false): Money {
  try {
    const parsed = createMoney(value as Money);
    if (
      parsed.currencyCode !== "CAD" ||
      (positive ? parsed.amountMinor <= 0n : parsed.amountMinor < 0n)
    )
      return invalid();
    return parsed;
  } catch {
    return invalid();
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid();
  return value as T;
}

export interface PaymentReconciliationRunInput {
  readonly runReference: PaymentReference;
  readonly mode: PaymentReconciliationMode;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly actorReference: PaymentReference | null;
  readonly purpose: "ReconcilePayments";
  readonly scheduledAt: PaymentInstant;
  readonly cutoffAt: PaymentInstant;
  readonly maxCandidates: number;
}

export function parsePaymentReconciliationRunInput(value: unknown): PaymentReconciliationRunInput {
  const raw = exact(value, [
    "runReference",
    "mode",
    "brandReference",
    "storeReference",
    "actorReference",
    "purpose",
    "scheduledAt",
    "cutoffAt",
    "maxCandidates",
  ]);
  let scheduledAt, cutoffAt;
  try {
    scheduledAt = parsePaymentInstant(raw.scheduledAt);
    cutoffAt = parsePaymentInstant(raw.cutoffAt);
  } catch {
    return invalid();
  }
  if (
    raw.purpose !== "ReconcilePayments" ||
    !Number.isSafeInteger(raw.maxCandidates) ||
    (raw.maxCandidates as number) < 1 ||
    (raw.maxCandidates as number) > 100 ||
    Date.parse(cutoffAt) > Date.parse(scheduledAt)
  )
    return invalid();
  try {
    return Object.freeze({
      runReference: parsePaymentReference(raw.runReference),
      mode: oneOf(raw.mode, ["Operational", "DailySettlement"] as const),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      actorReference:
        raw.actorReference === null ? null : parsePaymentReference(raw.actorReference),
      purpose: "ReconcilePayments",
      scheduledAt,
      cutoffAt,
      maxCandidates: raw.maxCandidates as number,
    });
  } catch {
    return invalid();
  }
}

export interface PaymentOperationalReconciliationCandidate {
  readonly candidateReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly providerAccountReference: PaymentReference;
  readonly providerIntentReference: ProviderReference;
  readonly environment: "Test" | "Live";
  readonly paymentMethod: PaymentMethod;
  readonly captureMode: CaptureMode;
  readonly internalStatus: ProviderStatus;
  readonly requestedAmount: Money;
  readonly capturedAmount: Money;
  readonly refundedAmount: Money;
  readonly lastObservedAt: PaymentInstant;
  readonly dueAt: PaymentInstant;
}

export function parseOperationalReconciliationCandidate(
  value: unknown,
): PaymentOperationalReconciliationCandidate {
  const raw = exact(value, [
    "candidateReference",
    "brandReference",
    "storeReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "providerAccountReference",
    "providerIntentReference",
    "environment",
    "paymentMethod",
    "captureMode",
    "internalStatus",
    "requestedAmount",
    "capturedAmount",
    "refundedAmount",
    "lastObservedAt",
    "dueAt",
  ]);
  if (raw.environment !== "Test" && raw.environment !== "Live") return invalid();
  try {
    const requestedAmount = money(raw.requestedAmount, true);
    const capturedAmount = money(raw.capturedAmount);
    const refundedAmount = money(raw.refundedAmount);
    if (
      capturedAmount.amountMinor > requestedAmount.amountMinor ||
      refundedAmount.amountMinor > capturedAmount.amountMinor
    )
      return invalid();
    return Object.freeze({
      candidateReference: parsePaymentReference(raw.candidateReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      orderReference: parsePaymentReference(raw.orderReference),
      providerAccountReference: parsePaymentReference(raw.providerAccountReference),
      providerIntentReference: parseProviderReference(raw.providerIntentReference),
      environment: raw.environment,
      paymentMethod: oneOf(raw.paymentMethod, paymentMethods),
      captureMode: oneOf(raw.captureMode, captureModes),
      internalStatus: oneOf(raw.internalStatus, providerStatuses),
      requestedAmount,
      capturedAmount,
      refundedAmount,
      lastObservedAt: parsePaymentInstant(raw.lastObservedAt),
      dueAt: parsePaymentInstant(raw.dueAt),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentSettlementReconciliationCandidate {
  readonly candidateReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly settlementReference: ProviderReference;
  readonly businessDate: string;
  readonly internalCapturedAmount: Money;
  readonly providerCapturedAmount: Money;
  readonly internalRefundedAmount: Money;
  readonly providerRefundedAmount: Money;
  readonly evidenceObservedAt: PaymentInstant;
}

export function parseSettlementReconciliationCandidate(
  value: unknown,
): PaymentSettlementReconciliationCandidate {
  const raw = exact(value, [
    "candidateReference",
    "brandReference",
    "storeReference",
    "settlementReference",
    "businessDate",
    "internalCapturedAmount",
    "providerCapturedAmount",
    "internalRefundedAmount",
    "providerRefundedAmount",
    "evidenceObservedAt",
  ]);
  if (
    typeof raw.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(raw.businessDate) ||
    Number.isNaN(Date.parse(`${raw.businessDate}T00:00:00.000Z`))
  )
    return invalid();
  try {
    const internalCapturedAmount = money(raw.internalCapturedAmount);
    const providerCapturedAmount = money(raw.providerCapturedAmount);
    const internalRefundedAmount = money(raw.internalRefundedAmount);
    const providerRefundedAmount = money(raw.providerRefundedAmount);
    if (
      internalRefundedAmount.amountMinor > internalCapturedAmount.amountMinor ||
      providerRefundedAmount.amountMinor > providerCapturedAmount.amountMinor
    )
      return invalid();
    return Object.freeze({
      candidateReference: parsePaymentReference(raw.candidateReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      settlementReference: parseProviderReference(raw.settlementReference),
      businessDate: raw.businessDate,
      internalCapturedAmount,
      providerCapturedAmount,
      internalRefundedAmount,
      providerRefundedAmount,
      evidenceObservedAt: parsePaymentInstant(raw.evidenceObservedAt),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentReconciliationCheck {
  readonly checkReference: PaymentReference;
  readonly runReference: PaymentReference;
  readonly candidateReference: PaymentReference;
  readonly mode: PaymentReconciliationMode;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference | null;
  readonly settlementReference: ProviderReference | null;
  readonly outcome: PaymentReconciliationOutcome;
  readonly differenceReason: PaymentReconciliationDifferenceReason | null;
  readonly internalStatus: ProviderStatus | null;
  readonly providerStatus: ProviderStatus | null;
  readonly internalCapturedAmount: Money;
  readonly providerCapturedAmount: Money | null;
  readonly internalRefundedAmount: Money;
  readonly providerRefundedAmount: Money | null;
  readonly exceptionReference: PaymentReference | null;
  readonly safeCode: string | null;
  readonly checkedAt: PaymentInstant;
}

export function parsePaymentReconciliationCheck(value: unknown): PaymentReconciliationCheck {
  const raw = exact(value, [
    "checkReference",
    "runReference",
    "candidateReference",
    "mode",
    "brandReference",
    "storeReference",
    "paymentIntentReference",
    "settlementReference",
    "outcome",
    "differenceReason",
    "internalStatus",
    "providerStatus",
    "internalCapturedAmount",
    "providerCapturedAmount",
    "internalRefundedAmount",
    "providerRefundedAmount",
    "exceptionReference",
    "safeCode",
    "checkedAt",
  ]);
  const mode = oneOf(raw.mode, ["Operational", "DailySettlement"] as const);
  const outcome = oneOf(raw.outcome, paymentReconciliationOutcomes);
  const differenceReason =
    raw.differenceReason === null
      ? null
      : oneOf(raw.differenceReason, paymentReconciliationDifferenceReasons);
  if (
    (mode === "Operational"
      ? raw.paymentIntentReference === null ||
        raw.settlementReference !== null ||
        raw.internalStatus === null
      : raw.paymentIntentReference !== null ||
        raw.settlementReference === null ||
        raw.internalStatus !== null ||
        raw.providerStatus !== null) ||
    (outcome === "Difference") !== (differenceReason !== null && raw.exceptionReference !== null) ||
    (outcome !== "Difference" && raw.exceptionReference !== null) ||
    (outcome === "Unavailable"
      ? typeof raw.safeCode !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(raw.safeCode)
      : raw.safeCode !== null) ||
    (raw.providerCapturedAmount === null) !== (raw.providerRefundedAmount === null) ||
    (outcome === "Unavailable"
      ? raw.providerCapturedAmount !== null
      : raw.providerCapturedAmount === null)
  )
    return invalid();
  try {
    const internalCapturedAmount = money(raw.internalCapturedAmount);
    const providerCapturedAmount =
      raw.providerCapturedAmount === null ? null : money(raw.providerCapturedAmount);
    const internalRefundedAmount = money(raw.internalRefundedAmount);
    const providerRefundedAmount =
      raw.providerRefundedAmount === null ? null : money(raw.providerRefundedAmount);
    if (
      internalRefundedAmount.amountMinor > internalCapturedAmount.amountMinor ||
      (providerCapturedAmount !== null &&
        providerRefundedAmount !== null &&
        providerRefundedAmount.amountMinor > providerCapturedAmount.amountMinor)
    )
      return invalid();
    return Object.freeze({
      checkReference: parsePaymentReference(raw.checkReference),
      runReference: parsePaymentReference(raw.runReference),
      candidateReference: parsePaymentReference(raw.candidateReference),
      mode,
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentIntentReference:
        raw.paymentIntentReference === null
          ? null
          : parsePaymentReference(raw.paymentIntentReference),
      settlementReference:
        raw.settlementReference === null ? null : parseProviderReference(raw.settlementReference),
      outcome,
      differenceReason,
      internalStatus:
        raw.internalStatus === null ? null : oneOf(raw.internalStatus, providerStatuses),
      providerStatus:
        raw.providerStatus === null ? null : oneOf(raw.providerStatus, providerStatuses),
      internalCapturedAmount,
      providerCapturedAmount,
      internalRefundedAmount,
      providerRefundedAmount,
      exceptionReference:
        raw.exceptionReference === null ? null : parsePaymentReference(raw.exceptionReference),
      safeCode: raw.safeCode as string | null,
      checkedAt: parsePaymentInstant(raw.checkedAt),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentReconciliationException {
  readonly exceptionReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly candidateReference: PaymentReference;
  readonly reason: PaymentReconciliationDifferenceReason;
  readonly severity: "Error" | "Critical";
  readonly status: "Open";
  readonly openedAt: PaymentInstant;
}

export interface PaymentReconciliationRunResult {
  readonly run: PaymentReconciliationRunInput;
  readonly status: "Completed";
  readonly completedAt: PaymentInstant;
  readonly checks: readonly PaymentReconciliationCheck[];
  readonly exceptions: readonly PaymentReconciliationException[];
  readonly counts: Readonly<Record<PaymentReconciliationOutcome, number>>;
}
