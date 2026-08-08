import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseOrderPaymentOutcomeDisposition,
  type OrderPaymentOutcomeDisposition,
} from "@rms/ordering";
import { createMoney, type Money } from "@rms/pricing";

import type { PaymentRefundedEnvelope } from "../contracts/payment-refunded-event.js";
import type {
  PaymentMethod,
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
import type { PaymentReconciliationException } from "./payment-reconciliation.js";
import { parsePaymentTerminalWatchdogExceptionReceipt } from "./payment-terminal-capture-watchdog.js";

export const paidWithoutFulfillableOrderJobName =
  "payment-paid-without-fulfillable-compensation:v1" as const;

export const paymentCompensationStatuses = [
  "InPersonActionRequired",
  "RefundPending",
  "ReconciliationRequired",
  "AwaitingProviderConfirmation",
  "AwaitingOperationsReconciliation",
  "Closed",
] as const;
export type PaymentCompensationStatus = (typeof paymentCompensationStatuses)[number];

export const paymentCompensationErrorCodes = [
  "PAYMENT_COMPENSATION_INPUT_INVALID",
  "PAYMENT_COMPENSATION_PERMISSION_DENIED",
  "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
  "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
  "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
  "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
] as const;
export type PaymentCompensationErrorCode = (typeof paymentCompensationErrorCodes)[number];

export class PaymentCompensationError extends Error {
  readonly code: PaymentCompensationErrorCode;

  constructor(code: PaymentCompensationErrorCode) {
    super("payment compensation is unavailable");
    this.name = "PaymentCompensationError";
    this.code = code;
  }
}

function invalid(): never {
  throw new PaymentCompensationError("PAYMENT_COMPENSATION_INPUT_INVALID");
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
    if (error instanceof PaymentCompensationError) throw error;
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
    if (error instanceof PaymentCompensationError) throw error;
    return invalid();
  }
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function referenceOrNull(value: unknown): PaymentReference | null {
  if (value === null) return null;
  try {
    return parsePaymentReference(value);
  } catch {
    return invalid();
  }
}

function digestOrNull(value: unknown): PaymentDigest | null {
  if (value === null) return null;
  try {
    return parsePaymentDigest(value);
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

function paymentMethod(value: unknown): PaymentMethod {
  if (value !== "OnlineCard" && value !== "TerminalCard" && value !== "TerminalInterac")
    return invalid();
  return value;
}

export type PaidWithoutFulfillableOrderDisposition = Extract<
  OrderPaymentOutcomeDisposition,
  { readonly disposition: "PaidWithoutFulfillableOrder" }
>;

export function parsePaidWithoutFulfillableOrderDisposition(
  value: unknown,
): PaidWithoutFulfillableOrderDisposition {
  try {
    const disposition = parseOrderPaymentOutcomeDisposition(value);
    if (disposition.disposition !== "PaidWithoutFulfillableOrder") return invalid();
    return disposition;
  } catch {
    return invalid();
  }
}

export interface PaymentCompensationIdentitySource {
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly environment: "Test" | "Live";
  readonly identityVersion: number;
  readonly identityDigest: PaymentDigest;
}

export function parsePaymentCompensationIdentitySource(
  value: unknown,
): PaymentCompensationIdentitySource {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "orderReference",
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "environment",
    "identityVersion",
    "identityDigest",
  ]);
  if (raw.environment !== "Test" && raw.environment !== "Live") return invalid();
  try {
    return Object.freeze({
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      orderReference: parsePaymentReference(raw.orderReference),
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      environment: raw.environment,
      identityVersion: positiveVersion(raw.identityVersion),
      identityDigest: parsePaymentDigest(raw.identityDigest),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentCompensationSource {
  readonly sourceReference: PaymentReference;
  readonly identityVersion: number;
  readonly identityDigest: PaymentDigest;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly providerAccountReference: PaymentReference;
  readonly providerIntentReference: ProviderReference;
  readonly environment: "Test" | "Live";
  readonly originalPaymentMethod: PaymentMethod;
  readonly captureMode: "Automatic" | "ManualPreferred";
  readonly status: "Captured";
  readonly requestedAmount: Money;
  readonly capturedAmount: Money;
  readonly confirmedRefundedAmount: Money;
  readonly pendingRefundClaimedAmount: Money;
  readonly terminalOccurredAt: PaymentInstant;
  readonly lastProviderObservedAt: PaymentInstant;
  readonly terminalEvidenceDigest: PaymentDigest;
  readonly sourceVersion: number;
  readonly sourceSnapshotDigest: PaymentDigest;
}

export function parsePaymentCompensationSource(value: unknown): PaymentCompensationSource {
  const raw = exact(value, [
    "sourceReference",
    "identityVersion",
    "identityDigest",
    "brandReference",
    "storeReference",
    "orderReference",
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "providerAccountReference",
    "providerIntentReference",
    "environment",
    "originalPaymentMethod",
    "captureMode",
    "status",
    "requestedAmount",
    "capturedAmount",
    "confirmedRefundedAmount",
    "pendingRefundClaimedAmount",
    "terminalOccurredAt",
    "lastProviderObservedAt",
    "terminalEvidenceDigest",
    "sourceVersion",
    "sourceSnapshotDigest",
  ]);
  if ((raw.environment !== "Test" && raw.environment !== "Live") || raw.status !== "Captured")
    return invalid();
  try {
    const method = paymentMethod(raw.originalPaymentMethod);
    const captureMode =
      raw.captureMode === "Automatic" || raw.captureMode === "ManualPreferred"
        ? raw.captureMode
        : invalid();
    const expectedCaptureMode = method === "OnlineCard" ? "Automatic" : "ManualPreferred";
    const requestedAmount = cadMoney(raw.requestedAmount, true);
    const capturedAmount = cadMoney(raw.capturedAmount, true);
    const confirmedRefundedAmount = cadMoney(raw.confirmedRefundedAmount, false);
    const pendingRefundClaimedAmount = cadMoney(raw.pendingRefundClaimedAmount, false);
    const terminalOccurredAt = parsePaymentInstant(raw.terminalOccurredAt);
    const lastProviderObservedAt = parsePaymentInstant(raw.lastProviderObservedAt);
    if (
      captureMode !== expectedCaptureMode ||
      capturedAmount.amountMinor > requestedAmount.amountMinor ||
      (method !== "TerminalCard" && capturedAmount.amountMinor !== requestedAmount.amountMinor) ||
      confirmedRefundedAmount.amountMinor + pendingRefundClaimedAmount.amountMinor >
        capturedAmount.amountMinor ||
      Date.parse(lastProviderObservedAt) < Date.parse(terminalOccurredAt)
    )
      return invalid();
    return Object.freeze({
      sourceReference: parsePaymentReference(raw.sourceReference),
      identityVersion: positiveVersion(raw.identityVersion),
      identityDigest: parsePaymentDigest(raw.identityDigest),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      orderReference: parsePaymentReference(raw.orderReference),
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      providerAccountReference: parsePaymentReference(raw.providerAccountReference),
      providerIntentReference: parseProviderReference(raw.providerIntentReference),
      environment: raw.environment,
      originalPaymentMethod: method,
      captureMode,
      status: "Captured",
      requestedAmount,
      capturedAmount,
      confirmedRefundedAmount,
      pendingRefundClaimedAmount,
      terminalOccurredAt,
      lastProviderObservedAt,
      terminalEvidenceDigest: parsePaymentDigest(raw.terminalEvidenceDigest),
      sourceVersion: positiveVersion(raw.sourceVersion),
      sourceSnapshotDigest: parsePaymentDigest(raw.sourceSnapshotDigest),
    });
  } catch (error) {
    if (error instanceof PaymentCompensationError) throw error;
    return invalid();
  }
}

export type PaymentCompensationSourceSnapshotContent = Omit<
  PaymentCompensationSource,
  "sourceSnapshotDigest"
>;

export function paymentCompensationSourceSnapshotContent(
  value: unknown,
): PaymentCompensationSourceSnapshotContent {
  const source = parsePaymentCompensationSource(value);
  return Object.freeze({
    sourceReference: source.sourceReference,
    identityVersion: source.identityVersion,
    identityDigest: source.identityDigest,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    orderReference: source.orderReference,
    paymentTransactionReference: source.paymentTransactionReference,
    paymentIntentReference: source.paymentIntentReference,
    paymentAttemptReference: source.paymentAttemptReference,
    providerAccountReference: source.providerAccountReference,
    providerIntentReference: source.providerIntentReference,
    environment: source.environment,
    originalPaymentMethod: source.originalPaymentMethod,
    captureMode: source.captureMode,
    status: source.status,
    requestedAmount: source.requestedAmount,
    capturedAmount: source.capturedAmount,
    confirmedRefundedAmount: source.confirmedRefundedAmount,
    pendingRefundClaimedAmount: source.pendingRefundClaimedAmount,
    terminalOccurredAt: source.terminalOccurredAt,
    lastProviderObservedAt: source.lastProviderObservedAt,
    terminalEvidenceDigest: source.terminalEvidenceDigest,
    sourceVersion: source.sourceVersion,
  });
}

export interface PaymentCompensationLeaseReceipt {
  readonly paymentAttemptReference: PaymentReference;
  readonly operationReference: PaymentReference;
  readonly jobName: typeof paidWithoutFulfillableOrderJobName;
  readonly fenceReference: PaymentReference;
  readonly fenceVersion: number;
  readonly claimedAt: PaymentInstant;
  readonly expiresAt: PaymentInstant;
  readonly status: "Claimed";
}

export function parsePaymentCompensationLeaseReceipt(
  value: unknown,
): PaymentCompensationLeaseReceipt {
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
  if (raw.jobName !== paidWithoutFulfillableOrderJobName || raw.status !== "Claimed")
    return invalid();
  try {
    const claimedAt = parsePaymentInstant(raw.claimedAt);
    const expiresAt = parsePaymentInstant(raw.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(claimedAt)) return invalid();
    return Object.freeze({
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      operationReference: parsePaymentReference(raw.operationReference),
      jobName: paidWithoutFulfillableOrderJobName,
      fenceReference: parsePaymentReference(raw.fenceReference),
      fenceVersion: positiveVersion(raw.fenceVersion),
      claimedAt,
      expiresAt,
      status: "Claimed",
    });
  } catch {
    return invalid();
  }
}

export interface PaymentInteracInPersonEvidence {
  readonly evidenceReference: PaymentReference;
  readonly compensationCaseReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly staffActorReference: PaymentReference;
  readonly readerReference: PaymentReference;
  readonly terminalLocationReference: PaymentReference;
  readonly amount: Money;
  readonly approval: "ApprovedReaderInPersonRefund";
  readonly issuedAt: PaymentInstant;
  readonly expiresAt: PaymentInstant;
  readonly evidenceDigest: PaymentDigest;
}

export function parsePaymentInteracInPersonEvidence(
  value: unknown,
): PaymentInteracInPersonEvidence {
  const raw = exact(value, [
    "evidenceReference",
    "compensationCaseReference",
    "brandReference",
    "storeReference",
    "paymentTransactionReference",
    "paymentAttemptReference",
    "staffActorReference",
    "readerReference",
    "terminalLocationReference",
    "amount",
    "approval",
    "issuedAt",
    "expiresAt",
    "evidenceDigest",
  ]);
  if (raw.approval !== "ApprovedReaderInPersonRefund") return invalid();
  try {
    const issuedAt = parsePaymentInstant(raw.issuedAt);
    const expiresAt = parsePaymentInstant(raw.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) return invalid();
    return Object.freeze({
      evidenceReference: parsePaymentReference(raw.evidenceReference),
      compensationCaseReference: parsePaymentReference(raw.compensationCaseReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      staffActorReference: parsePaymentReference(raw.staffActorReference),
      readerReference: parsePaymentReference(raw.readerReference),
      terminalLocationReference: parsePaymentReference(raw.terminalLocationReference),
      amount: cadMoney(raw.amount, true),
      approval: "ApprovedReaderInPersonRefund",
      issuedAt,
      expiresAt,
      evidenceDigest: parsePaymentDigest(raw.evidenceDigest),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentInteracInPersonClaimReceipt extends PaymentInteracInPersonEvidence {
  readonly actionReference: PaymentReference;
  readonly claimedAt: PaymentInstant;
  readonly claimDisposition: "Claimed" | "Existing";
  readonly status: "Claimed";
}

export function parsePaymentInteracInPersonClaimReceipt(
  value: unknown,
): PaymentInteracInPersonClaimReceipt {
  const raw = exact(value, [
    "evidenceReference",
    "compensationCaseReference",
    "brandReference",
    "storeReference",
    "paymentTransactionReference",
    "paymentAttemptReference",
    "staffActorReference",
    "readerReference",
    "terminalLocationReference",
    "amount",
    "approval",
    "issuedAt",
    "expiresAt",
    "evidenceDigest",
    "actionReference",
    "claimedAt",
    "claimDisposition",
    "status",
  ]);
  if (
    (raw.claimDisposition !== "Claimed" && raw.claimDisposition !== "Existing") ||
    raw.status !== "Claimed"
  )
    return invalid();
  const evidence = parsePaymentInteracInPersonEvidence(
    Object.fromEntries(
      [
        "evidenceReference",
        "compensationCaseReference",
        "brandReference",
        "storeReference",
        "paymentTransactionReference",
        "paymentAttemptReference",
        "staffActorReference",
        "readerReference",
        "terminalLocationReference",
        "amount",
        "approval",
        "issuedAt",
        "expiresAt",
        "evidenceDigest",
      ].map((field) => [field, raw[field]]),
    ),
  );
  try {
    const claimedAt = parsePaymentInstant(raw.claimedAt);
    if (
      Date.parse(claimedAt) < Date.parse(evidence.issuedAt) ||
      Date.parse(claimedAt) >= Date.parse(evidence.expiresAt)
    )
      return invalid();
    return Object.freeze({
      ...evidence,
      actionReference: parsePaymentReference(raw.actionReference),
      claimedAt,
      claimDisposition: raw.claimDisposition,
      status: "Claimed",
    });
  } catch {
    return invalid();
  }
}

export type PaymentCompensationActionPhase =
  "Claimed" | "InvocationUnknown" | "ProviderPending" | "ProviderConfirmed";

export interface PaymentCompensationActionReceipt {
  readonly actionReference: PaymentReference;
  readonly compensationCaseReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly originalPaymentMethod: PaymentMethod;
  readonly amount: Money;
  readonly interacEvidenceReference: PaymentReference | null;
  readonly interacEvidenceDigest: PaymentDigest | null;
  readonly dispositionDigest: PaymentDigest;
  readonly terminalEvidenceDigest: PaymentDigest;
  readonly sourceVersion: number;
  readonly sourceSnapshotDigest: PaymentDigest;
  readonly providerObservationDigest: PaymentDigest;
  readonly actionDigest: PaymentDigest;
  readonly providerIdempotencyKey: ProviderIdempotencyKey;
  readonly claimedAt: PaymentInstant;
  readonly claimDisposition: "Claimed" | "Existing";
  readonly phase: PaymentCompensationActionPhase;
}

export function parsePaymentCompensationActionReceipt(
  value: unknown,
): PaymentCompensationActionReceipt {
  const raw = exact(value, [
    "actionReference",
    "compensationCaseReference",
    "brandReference",
    "storeReference",
    "paymentTransactionReference",
    "paymentAttemptReference",
    "originalPaymentMethod",
    "amount",
    "interacEvidenceReference",
    "interacEvidenceDigest",
    "dispositionDigest",
    "terminalEvidenceDigest",
    "sourceVersion",
    "sourceSnapshotDigest",
    "providerObservationDigest",
    "actionDigest",
    "providerIdempotencyKey",
    "claimedAt",
    "claimDisposition",
    "phase",
  ]);
  if (
    (raw.claimDisposition !== "Claimed" && raw.claimDisposition !== "Existing") ||
    !["Claimed", "InvocationUnknown", "ProviderPending", "ProviderConfirmed"].includes(
      raw.phase as string,
    )
  )
    return invalid();
  try {
    const originalPaymentMethod = paymentMethod(raw.originalPaymentMethod);
    const interacEvidenceReference = referenceOrNull(raw.interacEvidenceReference);
    const interacEvidenceDigest = digestOrNull(raw.interacEvidenceDigest);
    if (
      originalPaymentMethod === "TerminalInterac"
        ? interacEvidenceReference === null || interacEvidenceDigest === null
        : interacEvidenceReference !== null || interacEvidenceDigest !== null
    )
      return invalid();
    return Object.freeze({
      actionReference: parsePaymentReference(raw.actionReference),
      compensationCaseReference: parsePaymentReference(raw.compensationCaseReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      originalPaymentMethod,
      amount: cadMoney(raw.amount, true),
      interacEvidenceReference,
      interacEvidenceDigest,
      dispositionDigest: parsePaymentDigest(raw.dispositionDigest),
      terminalEvidenceDigest: parsePaymentDigest(raw.terminalEvidenceDigest),
      sourceVersion: positiveVersion(raw.sourceVersion),
      sourceSnapshotDigest: parsePaymentDigest(raw.sourceSnapshotDigest),
      providerObservationDigest: parsePaymentDigest(raw.providerObservationDigest),
      actionDigest: parsePaymentDigest(raw.actionDigest),
      providerIdempotencyKey: parseProviderIdempotencyKey(raw.providerIdempotencyKey),
      claimedAt: parsePaymentInstant(raw.claimedAt),
      claimDisposition: raw.claimDisposition,
      phase: raw.phase as PaymentCompensationActionPhase,
    });
  } catch {
    return invalid();
  }
}

export interface PaymentProviderConfirmedRefundFact {
  readonly refundReference: PaymentReference;
  readonly eventReference: PaymentReference;
  readonly compensationCaseReference: PaymentReference;
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly originalPaymentMethod: PaymentMethod;
  readonly amount: Money;
  readonly source: "VerifiedWebhook" | "ProviderRetrieval";
  readonly providerConfirmedAt: PaymentInstant;
  readonly recordedAt: PaymentInstant;
  readonly evidenceDigest: PaymentDigest;
  readonly causationReference: PaymentReference;
}

export function parsePaymentProviderConfirmedRefundFact(
  value: unknown,
): PaymentProviderConfirmedRefundFact {
  const raw = exact(value, [
    "refundReference",
    "eventReference",
    "compensationCaseReference",
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "brandReference",
    "storeReference",
    "originalPaymentMethod",
    "amount",
    "source",
    "providerConfirmedAt",
    "recordedAt",
    "evidenceDigest",
    "causationReference",
  ]);
  if (raw.source !== "VerifiedWebhook" && raw.source !== "ProviderRetrieval") return invalid();
  try {
    const providerConfirmedAt = parsePaymentInstant(raw.providerConfirmedAt);
    const recordedAt = parsePaymentInstant(raw.recordedAt);
    if (Date.parse(recordedAt) < Date.parse(providerConfirmedAt)) return invalid();
    return Object.freeze({
      refundReference: parsePaymentReference(raw.refundReference),
      eventReference: parsePaymentReference(raw.eventReference),
      compensationCaseReference: parsePaymentReference(raw.compensationCaseReference),
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      orderReference: parsePaymentReference(raw.orderReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      originalPaymentMethod: paymentMethod(raw.originalPaymentMethod),
      amount: cadMoney(raw.amount, true),
      source: raw.source,
      providerConfirmedAt,
      recordedAt,
      evidenceDigest: parsePaymentDigest(raw.evidenceDigest),
      causationReference: parsePaymentReference(raw.causationReference),
    });
  } catch {
    return invalid();
  }
}

export interface PaymentRefundCompositionReceipt {
  readonly fact: PaymentProviderConfirmedRefundFact;
  readonly event: PaymentRefundedEnvelope;
}

export interface PaymentOperationsReconciliationReceipt {
  readonly receiptReference: PaymentReference;
  readonly compensationCaseReference: PaymentReference;
  readonly refundReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly actorReference: PaymentReference;
  readonly purpose: "ReconcilePaidWithoutFulfillableOrder";
  readonly refundEvidenceDigest: PaymentDigest;
  readonly reconciledAt: PaymentInstant;
  readonly audit: AppendAuditRecordInput;
}

export function parsePaymentOperationsReconciliationReceipt(
  value: unknown,
): PaymentOperationsReconciliationReceipt {
  const raw = exact(value, [
    "receiptReference",
    "compensationCaseReference",
    "refundReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "purpose",
    "refundEvidenceDigest",
    "reconciledAt",
    "audit",
  ]);
  if (raw.purpose !== "ReconcilePaidWithoutFulfillableOrder") return invalid();
  try {
    const receiptReference = parsePaymentReference(raw.receiptReference);
    const compensationCaseReference = parsePaymentReference(raw.compensationCaseReference);
    const refundReference = parsePaymentReference(raw.refundReference);
    const brandReference = parsePaymentReference(raw.brandReference);
    const storeReference = parsePaymentReference(raw.storeReference);
    const actorReference = parsePaymentReference(raw.actorReference);
    const reconciledAt = parsePaymentInstant(raw.reconciledAt);
    const rawAudit = exact(raw.audit, [
      "auditId",
      "brandId",
      "storeId",
      "actor",
      "actionCode",
      "targetType",
      "targetId",
      "reasonCode",
      "correlationId",
      "occurredAt",
      "sourceChannel",
      "dataClassification",
      "retentionPolicyCode",
      "retentionPolicyVersion",
    ]);
    const rawActor = exact(rawAudit.actor, ["type", "reference"]);
    if (rawActor.type !== "User") return invalid();
    const auditActorReference = parsePaymentReference(rawActor.reference);
    const auditActor = Object.freeze({
      type: "User" as const,
      reference: auditActorReference,
    });
    const auditCandidate = Object.freeze({
      auditId: rawAudit.auditId,
      brandId: rawAudit.brandId,
      storeId: rawAudit.storeId,
      actor: auditActor,
      actionCode: rawAudit.actionCode,
      targetType: rawAudit.targetType,
      targetId: rawAudit.targetId,
      reasonCode: rawAudit.reasonCode,
      correlationId: rawAudit.correlationId,
      occurredAt: rawAudit.occurredAt,
      sourceChannel: rawAudit.sourceChannel,
      dataClassification: rawAudit.dataClassification,
      retentionPolicyCode: rawAudit.retentionPolicyCode,
      retentionPolicyVersion: rawAudit.retentionPolicyVersion,
    });
    const validatedAudit = validateAuditRecord(auditCandidate, Date.parse(reconciledAt));
    const audit: AppendAuditRecordInput = Object.freeze({
      ...validatedAudit,
      actor: auditActor,
    });
    if (
      audit.brandId !== brandReference ||
      audit.storeId !== storeReference ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== actorReference ||
      auditActorReference !== actorReference ||
      audit.actionCode !== "PAYMENT_COMPENSATION_OPERATIONS_RECONCILED" ||
      audit.targetType !== "PaymentCompensationCase" ||
      audit.targetId !== compensationCaseReference ||
      audit.reasonCode !== "PAID_WITHOUT_FULFILLABLE_ORDER" ||
      audit.correlationId !== receiptReference ||
      audit.occurredAt !== reconciledAt ||
      audit.sourceChannel !== "OPERATIONS" ||
      audit.dataClassification !== "Restricted"
    )
      return invalid();
    return Object.freeze({
      receiptReference,
      compensationCaseReference,
      refundReference,
      brandReference,
      storeReference,
      actorReference,
      purpose: "ReconcilePaidWithoutFulfillableOrder",
      refundEvidenceDigest: parsePaymentDigest(raw.refundEvidenceDigest),
      reconciledAt,
      audit,
    });
  } catch {
    return invalid();
  }
}

export type PaymentCompensationRefundDisposition =
  | "NotStarted"
  | "InPersonActionRequired"
  | "RefundPending"
  | "ReconciliationRequired"
  | "AwaitingProviderConfirmation"
  | "ProviderConfirmed";
export type PaymentCompensationOperationsDisposition = "Pending" | "Reconciled";

export interface PaymentCompensationCase {
  readonly caseReference: PaymentReference;
  readonly operationReference: PaymentReference;
  readonly dispositionReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly environment: "Test" | "Live";
  readonly originalPaymentMethod: PaymentMethod;
  readonly reason: "PaidWithoutFulfillableOrder";
  readonly dispositionDigest: PaymentDigest;
  readonly terminalEvidenceDigest: PaymentDigest;
  readonly sourceVersion: number;
  readonly sourceSnapshotDigest: PaymentDigest;
  readonly severity: "Critical";
  readonly state: "Open" | "Closed";
  readonly refundDisposition: PaymentCompensationRefundDisposition;
  readonly operationsDisposition: PaymentCompensationOperationsDisposition;
  readonly refundReference: PaymentReference | null;
  readonly refundCompositionDigest: PaymentDigest | null;
  readonly refundEvidenceDigest: PaymentDigest | null;
  readonly refundConfirmedAt: PaymentInstant | null;
  readonly operationsReceiptReference: PaymentReference | null;
  readonly operationsReceiptDigest: PaymentDigest | null;
  readonly operationsRefundEvidenceDigest: PaymentDigest | null;
  readonly operationsReconciledAt: PaymentInstant | null;
  readonly openedAt: PaymentInstant;
  readonly updatedAt: PaymentInstant;
  readonly closedAt: PaymentInstant | null;
  readonly version: number;
}

export function parsePaymentCompensationCase(value: unknown): PaymentCompensationCase {
  const raw = exact(value, [
    "caseReference",
    "operationReference",
    "dispositionReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "environment",
    "originalPaymentMethod",
    "reason",
    "dispositionDigest",
    "terminalEvidenceDigest",
    "sourceVersion",
    "sourceSnapshotDigest",
    "severity",
    "state",
    "refundDisposition",
    "operationsDisposition",
    "refundReference",
    "refundCompositionDigest",
    "refundEvidenceDigest",
    "refundConfirmedAt",
    "operationsReceiptReference",
    "operationsReceiptDigest",
    "operationsRefundEvidenceDigest",
    "operationsReconciledAt",
    "openedAt",
    "updatedAt",
    "closedAt",
    "version",
  ]);
  if (
    (raw.environment !== "Test" && raw.environment !== "Live") ||
    raw.reason !== "PaidWithoutFulfillableOrder" ||
    raw.severity !== "Critical" ||
    (raw.state !== "Open" && raw.state !== "Closed") ||
    ![
      "NotStarted",
      "InPersonActionRequired",
      "RefundPending",
      "ReconciliationRequired",
      "AwaitingProviderConfirmation",
      "ProviderConfirmed",
    ].includes(raw.refundDisposition as string) ||
    (raw.operationsDisposition !== "Pending" && raw.operationsDisposition !== "Reconciled")
  )
    return invalid();
  try {
    const refundReference = referenceOrNull(raw.refundReference);
    const refundCompositionDigest = digestOrNull(raw.refundCompositionDigest);
    const refundEvidenceDigest = digestOrNull(raw.refundEvidenceDigest);
    const refundConfirmedAt = instantOrNull(raw.refundConfirmedAt);
    const operationsReceiptReference = referenceOrNull(raw.operationsReceiptReference);
    const operationsReceiptDigest = digestOrNull(raw.operationsReceiptDigest);
    const operationsRefundEvidenceDigest = digestOrNull(raw.operationsRefundEvidenceDigest);
    const operationsReconciledAt = instantOrNull(raw.operationsReconciledAt);
    const openedAt = parsePaymentInstant(raw.openedAt);
    const updatedAt = parsePaymentInstant(raw.updatedAt);
    const closedAt = instantOrNull(raw.closedAt);
    const refundConfirmed = raw.refundDisposition === "ProviderConfirmed";
    const operationsReconciled = raw.operationsDisposition === "Reconciled";
    const closed = refundConfirmed && operationsReconciled;
    if (
      (refundConfirmed
        ? refundReference === null ||
          refundCompositionDigest === null ||
          refundEvidenceDigest === null ||
          refundConfirmedAt === null
        : refundReference !== null ||
          refundCompositionDigest !== null ||
          refundEvidenceDigest !== null ||
          refundConfirmedAt !== null) ||
      (operationsReconciled
        ? operationsReceiptReference === null ||
          operationsReceiptDigest === null ||
          operationsRefundEvidenceDigest === null ||
          operationsReconciledAt === null
        : operationsReceiptReference !== null ||
          operationsReceiptDigest !== null ||
          operationsRefundEvidenceDigest !== null ||
          operationsReconciledAt !== null) ||
      (closed && refundEvidenceDigest !== operationsRefundEvidenceDigest) ||
      raw.state !== (closed ? "Closed" : "Open") ||
      (closed ? closedAt === null || closedAt !== updatedAt : closedAt !== null) ||
      Date.parse(updatedAt) < Date.parse(openedAt) ||
      (refundConfirmedAt !== null && Date.parse(refundConfirmedAt) > Date.parse(updatedAt)) ||
      (operationsReconciledAt !== null &&
        Date.parse(operationsReconciledAt) > Date.parse(updatedAt))
    )
      return invalid();
    return Object.freeze({
      caseReference: parsePaymentReference(raw.caseReference),
      operationReference: parsePaymentReference(raw.operationReference),
      dispositionReference: parsePaymentReference(raw.dispositionReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      orderReference: parsePaymentReference(raw.orderReference),
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      environment: raw.environment,
      originalPaymentMethod: paymentMethod(raw.originalPaymentMethod),
      reason: "PaidWithoutFulfillableOrder",
      dispositionDigest: parsePaymentDigest(raw.dispositionDigest),
      terminalEvidenceDigest: parsePaymentDigest(raw.terminalEvidenceDigest),
      sourceVersion: positiveVersion(raw.sourceVersion),
      sourceSnapshotDigest: parsePaymentDigest(raw.sourceSnapshotDigest),
      severity: "Critical",
      state: raw.state,
      refundDisposition: raw.refundDisposition as PaymentCompensationRefundDisposition,
      operationsDisposition: raw.operationsDisposition,
      refundReference,
      refundCompositionDigest,
      refundEvidenceDigest,
      refundConfirmedAt,
      operationsReceiptReference,
      operationsReceiptDigest,
      operationsRefundEvidenceDigest,
      operationsReconciledAt,
      openedAt,
      updatedAt,
      closedAt,
      version: positiveVersion(raw.version),
    });
  } catch {
    return invalid();
  }
}

export const paymentExceptionKinds = [
  "ReconciliationStateMismatch",
  "ReconciliationAmountMismatch",
  "ReconciliationRefundMismatch",
  "ReconciliationTerminalConflict",
  "CaptureDeadlineExceeded",
  "PaidWithoutFulfillableOrder",
] as const;
export type PaymentExceptionKind = (typeof paymentExceptionKinds)[number];

export interface PaymentExceptionProjectionSource {
  readonly exceptionReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference | null;
  readonly paymentAttemptReference: PaymentReference | null;
  readonly orderReference: PaymentReference | null;
  readonly kind: PaymentExceptionKind;
  readonly severity: "Error" | "Critical";
  readonly state: "Open" | "Closed";
  readonly refundDisposition: "NotApplicable" | PaymentCompensationRefundDisposition;
  readonly operationsDisposition: "NotApplicable" | PaymentCompensationOperationsDisposition;
  readonly openedAt: PaymentInstant;
  readonly updatedAt: PaymentInstant;
  readonly closedAt: PaymentInstant | null;
}

export function parsePaymentExceptionProjectionSource(
  value: unknown,
): PaymentExceptionProjectionSource {
  const raw = exact(value, [
    "exceptionReference",
    "brandReference",
    "storeReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "kind",
    "severity",
    "state",
    "refundDisposition",
    "operationsDisposition",
    "openedAt",
    "updatedAt",
    "closedAt",
  ]);
  if (
    typeof raw.kind !== "string" ||
    !paymentExceptionKinds.includes(raw.kind as PaymentExceptionKind) ||
    (raw.severity !== "Error" && raw.severity !== "Critical") ||
    (raw.state !== "Open" && raw.state !== "Closed") ||
    ![
      "NotApplicable",
      "NotStarted",
      "InPersonActionRequired",
      "RefundPending",
      "ReconciliationRequired",
      "AwaitingProviderConfirmation",
      "ProviderConfirmed",
    ].includes(raw.refundDisposition as string) ||
    !["NotApplicable", "Pending", "Reconciled"].includes(raw.operationsDisposition as string)
  )
    return invalid();
  try {
    const paymentIntentReference = referenceOrNull(raw.paymentIntentReference);
    const paymentAttemptReference = referenceOrNull(raw.paymentAttemptReference);
    const orderReference = referenceOrNull(raw.orderReference);
    const openedAt = parsePaymentInstant(raw.openedAt);
    const updatedAt = parsePaymentInstant(raw.updatedAt);
    const closedAt = instantOrNull(raw.closedAt);
    const paid = raw.kind === "PaidWithoutFulfillableOrder";
    const capture = raw.kind === "CaptureDeadlineExceeded";
    const terminalConflict = raw.kind === "ReconciliationTerminalConflict";
    if (
      Date.parse(updatedAt) < Date.parse(openedAt) ||
      (raw.state === "Closed" ? closedAt === null || closedAt !== updatedAt : closedAt !== null) ||
      (paid
        ? paymentIntentReference === null ||
          paymentAttemptReference === null ||
          orderReference === null ||
          raw.severity !== "Critical" ||
          raw.refundDisposition === "NotApplicable" ||
          raw.operationsDisposition === "NotApplicable" ||
          raw.state !==
            (raw.refundDisposition === "ProviderConfirmed" &&
            raw.operationsDisposition === "Reconciled"
              ? "Closed"
              : "Open")
        : raw.refundDisposition !== "NotApplicable" ||
          raw.operationsDisposition !== "NotApplicable" ||
          raw.state !== "Open") ||
      (capture && (paymentAttemptReference === null || raw.severity !== "Critical")) ||
      (!paid && !capture && raw.severity !== (terminalConflict ? "Critical" : "Error"))
    )
      return invalid();
    return Object.freeze({
      exceptionReference: parsePaymentReference(raw.exceptionReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      paymentIntentReference,
      paymentAttemptReference,
      orderReference,
      kind: raw.kind as PaymentExceptionKind,
      severity: raw.severity,
      state: raw.state,
      refundDisposition:
        raw.refundDisposition as PaymentExceptionProjectionSource["refundDisposition"],
      operationsDisposition:
        raw.operationsDisposition as PaymentExceptionProjectionSource["operationsDisposition"],
      openedAt,
      updatedAt,
      closedAt,
    });
  } catch {
    return invalid();
  }
}

export function createPaidWithoutFulfillableExceptionSource(
  value: PaymentCompensationCase,
): PaymentExceptionProjectionSource {
  const current = parsePaymentCompensationCase(value);
  return parsePaymentExceptionProjectionSource({
    exceptionReference: current.caseReference,
    brandReference: current.brandReference,
    storeReference: current.storeReference,
    paymentIntentReference: current.paymentIntentReference,
    paymentAttemptReference: current.paymentAttemptReference,
    orderReference: current.orderReference,
    kind: "PaidWithoutFulfillableOrder",
    severity: "Critical",
    state: current.state,
    refundDisposition: current.refundDisposition,
    operationsDisposition: current.operationsDisposition,
    openedAt: current.openedAt,
    updatedAt: current.updatedAt,
    closedAt: current.closedAt,
  });
}

type PaymentExceptionProjectionScope = Readonly<{
  brandReference: PaymentReference;
  storeReference: PaymentReference;
}>;

function parsePaymentExceptionProjectionScope(value: unknown): PaymentExceptionProjectionScope {
  const raw = exact(value, ["brandReference", "storeReference"]);
  try {
    return Object.freeze({
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
    });
  } catch {
    return invalid();
  }
}

const reconciliationExceptionKinds = Object.freeze({
  StateMismatch: "ReconciliationStateMismatch",
  AmountMismatch: "ReconciliationAmountMismatch",
  RefundMismatch: "ReconciliationRefundMismatch",
  TerminalConflict: "ReconciliationTerminalConflict",
} satisfies Readonly<Record<PaymentReconciliationException["reason"], PaymentExceptionKind>>);

export function createPaymentReconciliationExceptionSource(
  value: unknown,
  expectedScope: unknown,
): PaymentExceptionProjectionSource {
  const raw = exact(value, [
    "exceptionReference",
    "brandReference",
    "storeReference",
    "candidateReference",
    "reason",
    "severity",
    "status",
    "openedAt",
  ]);
  const scope = parsePaymentExceptionProjectionScope(expectedScope);
  if (
    typeof raw.reason !== "string" ||
    !Object.hasOwn(reconciliationExceptionKinds, raw.reason) ||
    raw.status !== "Open" ||
    raw.severity !== (raw.reason === "TerminalConflict" ? "Critical" : "Error")
  )
    return invalid();
  try {
    const brandReference = parsePaymentReference(raw.brandReference);
    const storeReference = parsePaymentReference(raw.storeReference);
    parsePaymentReference(raw.candidateReference);
    if (brandReference !== scope.brandReference || storeReference !== scope.storeReference)
      return invalid();
    const openedAt = parsePaymentInstant(raw.openedAt);
    return parsePaymentExceptionProjectionSource({
      exceptionReference: parsePaymentReference(raw.exceptionReference),
      brandReference,
      storeReference,
      paymentIntentReference: null,
      paymentAttemptReference: null,
      orderReference: null,
      kind: reconciliationExceptionKinds[raw.reason as PaymentReconciliationException["reason"]],
      severity: raw.severity,
      state: "Open",
      refundDisposition: "NotApplicable",
      operationsDisposition: "NotApplicable",
      openedAt,
      updatedAt: openedAt,
      closedAt: null,
    });
  } catch (error) {
    if (error instanceof PaymentCompensationError) throw error;
    return invalid();
  }
}

export function createPaymentTerminalWatchdogExceptionSource(
  value: unknown,
  expectedScope: unknown,
): PaymentExceptionProjectionSource {
  const scope = parsePaymentExceptionProjectionScope(expectedScope);
  try {
    const receipt = parsePaymentTerminalWatchdogExceptionReceipt(value);
    if (
      receipt.brandReference !== scope.brandReference ||
      receipt.storeReference !== scope.storeReference
    )
      return invalid();
    return parsePaymentExceptionProjectionSource({
      exceptionReference: receipt.exceptionReference,
      brandReference: receipt.brandReference,
      storeReference: receipt.storeReference,
      paymentIntentReference: null,
      paymentAttemptReference: receipt.paymentAttemptReference,
      orderReference: null,
      kind: "CaptureDeadlineExceeded",
      severity: "Critical",
      state: "Open",
      refundDisposition: "NotApplicable",
      operationsDisposition: "NotApplicable",
      openedAt: receipt.openedAt,
      updatedAt: receipt.openedAt,
      closedAt: null,
    });
  } catch (error) {
    if (error instanceof PaymentCompensationError) throw error;
    return invalid();
  }
}

export interface PaymentCompensationResult {
  readonly status: PaymentCompensationStatus;
  readonly operationReference: PaymentReference;
  readonly caseReference: PaymentReference;
  readonly evaluatedAt: PaymentInstant;
  readonly refundReference: PaymentReference | null;
  readonly eventReference: PaymentReference | null;
  readonly exceptionSource: PaymentExceptionProjectionSource;
}

export function parsePaymentCompensationResult(value: unknown): PaymentCompensationResult {
  const raw = exact(value, [
    "status",
    "operationReference",
    "caseReference",
    "evaluatedAt",
    "refundReference",
    "eventReference",
    "exceptionSource",
  ]);
  if (
    typeof raw.status !== "string" ||
    !paymentCompensationStatuses.includes(raw.status as PaymentCompensationStatus)
  )
    return invalid();
  try {
    const caseReference = parsePaymentReference(raw.caseReference);
    const refundReference = referenceOrNull(raw.refundReference);
    const eventReference = referenceOrNull(raw.eventReference);
    const exceptionSource = parsePaymentExceptionProjectionSource(raw.exceptionSource);
    const evaluatedAt = parsePaymentInstant(raw.evaluatedAt);
    const providerConfirmed = exceptionSource.refundDisposition === "ProviderConfirmed";
    const expectedStatus = providerConfirmed
      ? exceptionSource.operationsDisposition === "Reconciled"
        ? "Closed"
        : "AwaitingOperationsReconciliation"
      : exceptionSource.refundDisposition === "InPersonActionRequired"
        ? "InPersonActionRequired"
        : exceptionSource.refundDisposition === "RefundPending"
          ? "RefundPending"
          : exceptionSource.refundDisposition === "ReconciliationRequired"
            ? "ReconciliationRequired"
            : exceptionSource.refundDisposition === "AwaitingProviderConfirmation"
              ? "AwaitingProviderConfirmation"
              : null;
    if (
      exceptionSource.exceptionReference !== caseReference ||
      evaluatedAt !== exceptionSource.updatedAt ||
      expectedStatus === null ||
      raw.status !== expectedStatus ||
      (providerConfirmed
        ? refundReference === null || eventReference === null
        : refundReference !== null || eventReference !== null) ||
      (expectedStatus === "Closed"
        ? exceptionSource.state !== "Closed"
        : exceptionSource.state !== "Open")
    )
      return invalid();
    return Object.freeze({
      status: raw.status as PaymentCompensationStatus,
      operationReference: parsePaymentReference(raw.operationReference),
      caseReference,
      evaluatedAt,
      refundReference,
      eventReference,
      exceptionSource,
    });
  } catch {
    return invalid();
  }
}

export interface PaymentCompensationOperationRecord {
  readonly disposition: PaidWithoutFulfillableOrderDisposition;
  readonly requestDigest: PaymentDigest;
  readonly result: PaymentCompensationResult;
  readonly resultDigest: PaymentDigest;
}

export function parsePaymentCompensationOperationRecord(
  value: unknown,
): PaymentCompensationOperationRecord {
  const raw = exact(value, ["disposition", "requestDigest", "result", "resultDigest"]);
  return Object.freeze({
    disposition: parsePaidWithoutFulfillableOrderDisposition(raw.disposition),
    requestDigest: parsePaymentDigest(raw.requestDigest),
    result: parsePaymentCompensationResult(raw.result),
    resultDigest: parsePaymentDigest(raw.resultDigest),
  });
}
