import { createMoney, type Money } from "@rms/pricing";

import type {
  PaymentReference,
  ProviderIdempotencyKey,
  ProviderReference,
} from "../contracts/payment-provider-adapter.js";
import {
  parsePaymentReference,
  parseProviderIdempotencyKey,
  parseProviderReference,
} from "./payment-provider-adapter.js";
import {
  parsePaymentDigest,
  parsePaymentInstant,
  type PaymentDigest,
  type PaymentInstant,
} from "./payment-intent-creation.js";

export const paymentTerminalCaptureWatchdogJobName =
  "payment-terminal-capture-watchdog:v1" as const;
export const paymentTerminalCaptureWatchdogStatuses = [
  "AwaitingOrderAcceptance",
  "PendingCapture",
  "CaptureConfirmed",
  "CancelConfirmed",
  "ReconciliationRequired",
  "InteracSingleMessage",
] as const;
export type PaymentTerminalCaptureWatchdogStatus =
  (typeof paymentTerminalCaptureWatchdogStatuses)[number];

export const paymentTerminalCaptureWatchdogErrorCodes = [
  "PAYMENT_TERMINAL_WATCHDOG_INPUT_INVALID",
  "PAYMENT_TERMINAL_WATCHDOG_PERMISSION_DENIED",
  "PAYMENT_TERMINAL_WATCHDOG_LEASE_UNAVAILABLE",
  "PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT",
  "PAYMENT_TERMINAL_WATCHDOG_SOURCE_UNAVAILABLE",
  "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
] as const;
export type PaymentTerminalCaptureWatchdogErrorCode =
  (typeof paymentTerminalCaptureWatchdogErrorCodes)[number];

export class PaymentTerminalCaptureWatchdogError extends Error {
  readonly code: PaymentTerminalCaptureWatchdogErrorCode;

  constructor(code: PaymentTerminalCaptureWatchdogErrorCode) {
    super("payment terminal capture watchdog is unavailable");
    this.name = "PaymentTerminalCaptureWatchdogError";
    this.code = code;
  }
}

function invalid(): never {
  throw new PaymentTerminalCaptureWatchdogError("PAYMENT_TERMINAL_WATCHDOG_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    )
      return invalid();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof PaymentTerminalCaptureWatchdogError) throw error;
    return invalid();
  }
}

function cadMoney(value: unknown, positive: boolean): Money {
  try {
    const parsed = createMoney(value as Money);
    if (
      parsed.currencyCode !== "CAD" ||
      (positive ? parsed.amountMinor <= 0n : parsed.amountMinor < 0n)
    )
      return invalid();
    return parsed;
  } catch (error) {
    if (error instanceof PaymentTerminalCaptureWatchdogError) throw error;
    return invalid();
  }
}

function referenceOrNull(value: unknown): PaymentReference | null {
  if (value === null) return null;
  try {
    return parsePaymentReference(value);
  } catch {
    return invalid();
  }
}

function instantOrNull(value: unknown): PaymentInstant | null {
  if (value === null) return null;
  try {
    return parsePaymentInstant(value);
  } catch {
    return invalid();
  }
}

export interface PaymentTerminalCaptureWatchdogCommand {
  readonly operationReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly actorReference: PaymentReference | null;
  readonly purpose: "WatchTerminalAuthorization";
  readonly scheduledAt: PaymentInstant;
}

export function parsePaymentTerminalCaptureWatchdogCommand(
  value: unknown,
): PaymentTerminalCaptureWatchdogCommand {
  const raw = exact(value, [
    "operationReference",
    "brandReference",
    "storeReference",
    "paymentAttemptReference",
    "actorReference",
    "purpose",
    "scheduledAt",
  ]);
  if (raw.purpose !== "WatchTerminalAuthorization") return invalid();
  try {
    return Object.freeze({
      operationReference: parsePaymentReference(raw.operationReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      actorReference: referenceOrNull(raw.actorReference),
      purpose: "WatchTerminalAuthorization",
      scheduledAt: parsePaymentInstant(raw.scheduledAt),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentTerminalAuthorizationEvidence {
  readonly authorizationReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly paymentOperationReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly orderBatchReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly providerAccountReference: PaymentReference;
  readonly providerIntentReference: ProviderReference;
  readonly environment: "Test" | "Live";
  readonly paymentMethod: "TerminalCard" | "TerminalInterac";
  readonly captureMode: "ManualPreferred";
  readonly status: "Authorized" | "Captured";
  readonly requestedAmount: Money;
  readonly authorizedAmount: Money;
  readonly capturedAmount: Money;
  readonly authorizedAt: PaymentInstant;
  readonly providerCaptureBeforeAt: PaymentInstant | null;
  readonly sourceVersion: number;
  readonly evidenceDigest: PaymentDigest;
}

export function parsePaymentTerminalAuthorizationEvidence(
  value: unknown,
): PaymentTerminalAuthorizationEvidence {
  const raw = exact(value, [
    "authorizationReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "paymentOperationReference",
    "orderReference",
    "orderBatchReference",
    "brandReference",
    "storeReference",
    "providerAccountReference",
    "providerIntentReference",
    "environment",
    "paymentMethod",
    "captureMode",
    "status",
    "requestedAmount",
    "authorizedAmount",
    "capturedAmount",
    "authorizedAt",
    "providerCaptureBeforeAt",
    "sourceVersion",
    "evidenceDigest",
  ]);
  if (
    (raw.environment !== "Test" && raw.environment !== "Live") ||
    (raw.paymentMethod !== "TerminalCard" && raw.paymentMethod !== "TerminalInterac") ||
    raw.captureMode !== "ManualPreferred" ||
    (raw.status !== "Authorized" && raw.status !== "Captured") ||
    !Number.isSafeInteger(raw.sourceVersion) ||
    (raw.sourceVersion as number) < 1
  )
    return invalid();
  try {
    const requestedAmount = cadMoney(raw.requestedAmount, true);
    const authorizedAmount = cadMoney(raw.authorizedAmount, true);
    const capturedAmount = cadMoney(raw.capturedAmount, false);
    const authorizedAt = parsePaymentInstant(raw.authorizedAt);
    const providerCaptureBeforeAt = instantOrNull(raw.providerCaptureBeforeAt);
    const cardAuthorized = raw.paymentMethod === "TerminalCard" && raw.status === "Authorized";
    const interacCaptured = raw.paymentMethod === "TerminalInterac" && raw.status === "Captured";
    if (
      (!cardAuthorized && !interacCaptured) ||
      requestedAmount.amountMinor !== authorizedAmount.amountMinor ||
      (cardAuthorized && capturedAmount.amountMinor !== 0n) ||
      (interacCaptured && capturedAmount.amountMinor !== requestedAmount.amountMinor) ||
      (raw.paymentMethod === "TerminalInterac" &&
        (raw.status !== "Captured" || providerCaptureBeforeAt !== null)) ||
      (providerCaptureBeforeAt !== null &&
        Date.parse(providerCaptureBeforeAt) <= Date.parse(authorizedAt))
    )
      return invalid();
    return Object.freeze({
      authorizationReference: parsePaymentReference(raw.authorizationReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      paymentOperationReference: parsePaymentReference(raw.paymentOperationReference),
      orderReference: parsePaymentReference(raw.orderReference),
      orderBatchReference: parsePaymentReference(raw.orderBatchReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      providerAccountReference: parsePaymentReference(raw.providerAccountReference),
      providerIntentReference: parseProviderReference(raw.providerIntentReference),
      environment: raw.environment,
      paymentMethod: raw.paymentMethod,
      captureMode: "ManualPreferred",
      status: raw.status,
      requestedAmount,
      authorizedAmount,
      capturedAmount,
      authorizedAt,
      providerCaptureBeforeAt,
      sourceVersion: raw.sourceVersion as number,
      evidenceDigest: parsePaymentDigest(raw.evidenceDigest),
    });
  } catch (error) {
    if (error instanceof PaymentTerminalCaptureWatchdogError) throw error;
    return invalid();
  }
}

export interface PaymentTerminalCaptureWatchdogResult {
  readonly status: PaymentTerminalCaptureWatchdogStatus;
  readonly evaluatedAt: PaymentInstant;
  readonly alertAt: PaymentInstant | null;
  readonly targetCaptureAt: PaymentInstant | null;
  readonly hardDeadline: PaymentInstant | null;
  readonly taskReference: PaymentReference | null;
  readonly exceptionReference: PaymentReference | null;
}

export function parsePaymentTerminalCaptureWatchdogResult(
  value: unknown,
): PaymentTerminalCaptureWatchdogResult {
  const raw = exact(value, [
    "status",
    "evaluatedAt",
    "alertAt",
    "targetCaptureAt",
    "hardDeadline",
    "taskReference",
    "exceptionReference",
  ]);
  if (
    typeof raw.status !== "string" ||
    !paymentTerminalCaptureWatchdogStatuses.includes(
      raw.status as PaymentTerminalCaptureWatchdogStatus,
    )
  )
    return invalid();
  try {
    const evaluatedAt = parsePaymentInstant(raw.evaluatedAt);
    const alertAt = instantOrNull(raw.alertAt);
    const targetCaptureAt = instantOrNull(raw.targetCaptureAt);
    const hardDeadline = instantOrNull(raw.hardDeadline);
    const taskReference = referenceOrNull(raw.taskReference);
    const exceptionReference = referenceOrNull(raw.exceptionReference);
    if (
      (raw.status === "InteracSingleMessage"
        ? alertAt !== null ||
          targetCaptureAt !== null ||
          hardDeadline !== null ||
          taskReference !== null ||
          exceptionReference !== null
        : alertAt === null || hardDeadline === null) ||
      (raw.status !== "InteracSingleMessage" && targetCaptureAt === null) ||
      (raw.status === "CancelConfirmed" && exceptionReference === null) ||
      (exceptionReference !== null && taskReference === null) ||
      (raw.status !== "CaptureConfirmed" &&
        raw.status !== "InteracSingleMessage" &&
        alertAt !== null &&
        Date.parse(evaluatedAt) >= Date.parse(alertAt) &&
        taskReference === null) ||
      (raw.status === "ReconciliationRequired" &&
        hardDeadline !== null &&
        Date.parse(evaluatedAt) >= Date.parse(hardDeadline) &&
        exceptionReference === null) ||
      (exceptionReference !== null &&
        raw.status !== "CancelConfirmed" &&
        raw.status !== "ReconciliationRequired" &&
        raw.status !== "CaptureConfirmed") ||
      (alertAt !== null &&
        targetCaptureAt !== null &&
        hardDeadline !== null &&
        (Date.parse(alertAt) > Date.parse(targetCaptureAt) ||
          Date.parse(targetCaptureAt) > Date.parse(hardDeadline))) ||
      ((raw.status === "AwaitingOrderAcceptance" || raw.status === "PendingCapture") &&
        hardDeadline !== null &&
        Date.parse(evaluatedAt) >= Date.parse(hardDeadline)) ||
      (raw.status === "CancelConfirmed" &&
        hardDeadline !== null &&
        Date.parse(evaluatedAt) < Date.parse(hardDeadline))
    )
      return invalid();
    return Object.freeze({
      status: raw.status as PaymentTerminalCaptureWatchdogStatus,
      evaluatedAt,
      alertAt,
      targetCaptureAt,
      hardDeadline,
      taskReference,
      exceptionReference,
    });
  } catch (error) {
    if (error instanceof PaymentTerminalCaptureWatchdogError) throw error;
    return invalid();
  }
}

export interface PaymentTerminalCaptureWatchdogOperationRecord {
  readonly command: PaymentTerminalCaptureWatchdogCommand;
  readonly requestDigest: PaymentDigest;
  readonly result: PaymentTerminalCaptureWatchdogResult;
}

export function parsePaymentTerminalCaptureWatchdogOperationRecord(
  value: unknown,
): PaymentTerminalCaptureWatchdogOperationRecord {
  const raw = exact(value, ["command", "requestDigest", "result"]);
  return Object.freeze({
    command: parsePaymentTerminalCaptureWatchdogCommand(raw.command),
    requestDigest: parsePaymentDigest(raw.requestDigest),
    result: parsePaymentTerminalCaptureWatchdogResult(raw.result),
  });
}

export type PaymentTerminalWatchdogAction = "Capture" | "Cancel";

export interface PaymentTerminalWatchdogActionReceipt {
  readonly action: PaymentTerminalWatchdogAction;
  readonly actionReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly authorizationDigest: PaymentDigest;
  readonly acceptanceDigest: PaymentDigest | null;
  readonly actionDigest: PaymentDigest;
  readonly providerIdempotencyKey: ProviderIdempotencyKey;
  readonly claimedAt: PaymentInstant;
  readonly claimDisposition: "Claimed" | "Existing";
  readonly phase: "Claimed" | "InvocationUnknown" | "ResolvedAuthorized" | "TerminalObserved";
}

export function parsePaymentTerminalWatchdogActionReceipt(
  value: unknown,
): PaymentTerminalWatchdogActionReceipt {
  const raw = exact(value, [
    "action",
    "actionReference",
    "brandReference",
    "storeReference",
    "paymentAttemptReference",
    "authorizationDigest",
    "acceptanceDigest",
    "actionDigest",
    "providerIdempotencyKey",
    "claimedAt",
    "claimDisposition",
    "phase",
  ]);
  if (
    (raw.action !== "Capture" && raw.action !== "Cancel") ||
    (raw.claimDisposition !== "Claimed" && raw.claimDisposition !== "Existing") ||
    !["Claimed", "InvocationUnknown", "ResolvedAuthorized", "TerminalObserved"].includes(
      raw.phase as string,
    )
  )
    return invalid();
  try {
    const acceptanceDigest =
      raw.acceptanceDigest === null ? null : parsePaymentDigest(raw.acceptanceDigest);
    if (
      (raw.action === "Capture" && acceptanceDigest === null) ||
      (raw.action === "Cancel" && acceptanceDigest !== null)
    )
      return invalid();
    return Object.freeze({
      action: raw.action,
      actionReference: parsePaymentReference(raw.actionReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      authorizationDigest: parsePaymentDigest(raw.authorizationDigest),
      acceptanceDigest,
      actionDigest: parsePaymentDigest(raw.actionDigest),
      providerIdempotencyKey: parseProviderIdempotencyKey(raw.providerIdempotencyKey),
      claimedAt: parsePaymentInstant(raw.claimedAt),
      claimDisposition: raw.claimDisposition,
      phase: raw.phase as PaymentTerminalWatchdogActionReceipt["phase"],
    });
  } catch {
    return invalid();
  }
}

export interface PaymentTerminalWatchdogLeaseReceipt {
  readonly paymentAttemptReference: PaymentReference;
  readonly operationReference: PaymentReference;
  readonly jobName: "payment-terminal-capture-watchdog:v1";
  readonly fenceReference: PaymentReference;
  readonly fenceVersion: number;
  readonly claimedAt: PaymentInstant;
  readonly expiresAt: PaymentInstant;
  readonly status: "Claimed";
}

export function parsePaymentTerminalWatchdogLeaseReceipt(
  value: unknown,
): PaymentTerminalWatchdogLeaseReceipt {
  const raw = exact(value, [
    "paymentAttemptReference",
    "operationReference",
    "jobName",
    "fenceReference",
    "fenceVersion",
    "claimedAt",
    "expiresAt",
    "status",
  ]);
  if (
    raw.jobName !== paymentTerminalCaptureWatchdogJobName ||
    raw.status !== "Claimed" ||
    !Number.isSafeInteger(raw.fenceVersion) ||
    (raw.fenceVersion as number) < 1
  )
    return invalid();
  try {
    const claimedAt = parsePaymentInstant(raw.claimedAt);
    const expiresAt = parsePaymentInstant(raw.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(claimedAt)) return invalid();
    return Object.freeze({
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      operationReference: parsePaymentReference(raw.operationReference),
      jobName: paymentTerminalCaptureWatchdogJobName,
      fenceReference: parsePaymentReference(raw.fenceReference),
      fenceVersion: raw.fenceVersion as number,
      claimedAt,
      expiresAt,
      status: "Claimed",
    });
  } catch {
    return invalid();
  }
}

export interface PaymentTerminalWatchdogTerminalReceipt {
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly outcome: "Captured" | "Failed";
  readonly amount: Money | null;
  readonly failureReason: "Cancelled" | "ProviderRejected" | null;
  readonly observationReference: PaymentReference;
  readonly causationReference: PaymentReference;
  readonly source: "VerifiedWebhook" | "ProviderRetrieval";
  readonly evidenceDigest: PaymentDigest;
  readonly occurredAt: PaymentInstant;
}

export function parsePaymentTerminalWatchdogTerminalReceipt(
  value: unknown,
): PaymentTerminalWatchdogTerminalReceipt {
  const raw = exact(value, [
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "brandReference",
    "storeReference",
    "outcome",
    "amount",
    "failureReason",
    "observationReference",
    "causationReference",
    "source",
    "evidenceDigest",
    "occurredAt",
  ]);
  if (
    (raw.outcome !== "Captured" && raw.outcome !== "Failed") ||
    (raw.source !== "VerifiedWebhook" && raw.source !== "ProviderRetrieval") ||
    (raw.outcome === "Captured"
      ? raw.amount === null || raw.failureReason !== null
      : raw.amount !== null ||
        (raw.failureReason !== "Cancelled" && raw.failureReason !== "ProviderRejected"))
  )
    return invalid();
  try {
    return Object.freeze({
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      orderReference: parsePaymentReference(raw.orderReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      outcome: raw.outcome,
      amount: raw.outcome === "Captured" ? cadMoney(raw.amount, true) : null,
      failureReason:
        raw.outcome === "Captured" ? null : (raw.failureReason as "Cancelled" | "ProviderRejected"),
      observationReference: parsePaymentReference(raw.observationReference),
      causationReference: parsePaymentReference(raw.causationReference),
      source: raw.source,
      evidenceDigest: parsePaymentDigest(raw.evidenceDigest),
      occurredAt: parsePaymentInstant(raw.occurredAt),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentTerminalWatchdogExceptionReceipt {
  readonly exceptionReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly evidenceDigest: PaymentDigest;
  readonly reason: "CaptureDeadlineExceeded";
  readonly severity: "Critical";
  readonly status: "Open";
  readonly openedAt: PaymentInstant;
}

export function parsePaymentTerminalWatchdogExceptionReceipt(
  value: unknown,
): PaymentTerminalWatchdogExceptionReceipt {
  const raw = exact(value, [
    "exceptionReference",
    "brandReference",
    "storeReference",
    "paymentAttemptReference",
    "evidenceDigest",
    "reason",
    "severity",
    "status",
    "openedAt",
  ]);
  if (
    raw.reason !== "CaptureDeadlineExceeded" ||
    raw.severity !== "Critical" ||
    raw.status !== "Open"
  )
    return invalid();
  try {
    return Object.freeze({
      exceptionReference: parsePaymentReference(raw.exceptionReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      evidenceDigest: parsePaymentDigest(raw.evidenceDigest),
      reason: "CaptureDeadlineExceeded",
      severity: "Critical",
      status: "Open",
      openedAt: parsePaymentInstant(raw.openedAt),
    });
  } catch {
    return invalid();
  }
}
