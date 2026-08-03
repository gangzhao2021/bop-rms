import { parsePaymentReference } from "./payment-provider-adapter.js";
import {
  createVerifiedProviderWebhook,
  parseStripeEventReference,
  parseStripeEventType,
  parseWebhookDigest,
  parseWebhookInstant,
  type StripeEventReference,
  type StripeEventType,
  type WebhookDigest,
  type WebhookInstant,
} from "./provider-webhook-verification.js";
import type { PaymentReference } from "../contracts/payment-provider-adapter.js";

export const paymentWebhookInboxConsumer = "payment.provider-webhook.v1" as const;

export const paymentWebhookInboxErrorCodes = [
  "PAYMENT_WEBHOOK_INBOX_INPUT_INVALID",
  "PAYMENT_WEBHOOK_INBOX_EVIDENCE_MISMATCH",
  "PAYMENT_WEBHOOK_INBOX_IDENTITY_CONFLICT",
  "PAYMENT_WEBHOOK_INBOX_NOT_FOUND",
  "PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE",
] as const;
export type PaymentWebhookInboxErrorCode = (typeof paymentWebhookInboxErrorCodes)[number];

export class PaymentWebhookInboxError extends Error {
  readonly code: PaymentWebhookInboxErrorCode;

  constructor(code: PaymentWebhookInboxErrorCode) {
    super("payment webhook inbox operation failed");
    this.name = "PaymentWebhookInboxError";
    this.code = code;
  }
}

function invalid(
  code: PaymentWebhookInboxErrorCode = "PAYMENT_WEBHOOK_INBOX_INPUT_INVALID",
): never {
  throw new PaymentWebhookInboxError(code);
}

export interface PaymentWebhookReceiptSnapshot {
  readonly webhookReceiptReference: PaymentReference;
  readonly provider: "Stripe";
  readonly environment: "Test" | "Live";
  readonly providerAccountReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly providerEventReference: StripeEventReference;
  readonly providerEventType: StripeEventType;
  readonly providerCreatedAt: WebhookInstant;
  readonly receivedAt: WebhookInstant;
  readonly signatureTimestamp: WebhookInstant;
  readonly evidenceDigest: WebhookDigest;
  readonly acceptedAt: WebhookInstant;
  readonly rawEvidenceExpiresAt: WebhookInstant;
  readonly dedupeExpiresAt: WebhookInstant;
}

export interface PaymentWebhookInboxRecord extends PaymentWebhookReceiptSnapshot {
  copyRawEvidence(): Uint8Array;
}

export interface PaymentWebhookProcessingCompletion {
  readonly webhookReceiptReference: PaymentReference;
  readonly consumerName: typeof paymentWebhookInboxConsumer;
  readonly processedAt: WebhookInstant;
  readonly resultDigest: WebhookDigest;
}

export type AcceptPaymentWebhookResult = Readonly<{
  status: "Accepted" | "Duplicate";
  disposition: "Acknowledge";
  receipt: PaymentWebhookReceiptSnapshot;
}>;

export type ProcessPaymentWebhookResult = Readonly<{
  status: "Completed" | "AlreadyCompleted";
  completion: PaymentWebhookProcessingCompletion;
}>;

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
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      output[field] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof PaymentWebhookInboxError) throw error;
    return invalid();
  }
}

const receiptFields = [
  "webhookReceiptReference",
  "provider",
  "environment",
  "providerAccountReference",
  "brandReference",
  "storeReference",
  "providerEventReference",
  "providerEventType",
  "providerCreatedAt",
  "receivedAt",
  "signatureTimestamp",
  "evidenceDigest",
  "acceptedAt",
  "rawEvidenceExpiresAt",
  "dedupeExpiresAt",
] as const;

export function parsePaymentWebhookReceiptSnapshot(value: unknown): PaymentWebhookReceiptSnapshot {
  const raw = exact(value, receiptFields);
  if (raw.provider !== "Stripe" || (raw.environment !== "Test" && raw.environment !== "Live"))
    return invalid();
  const receivedAt = parseWebhookInstant(raw.receivedAt);
  const acceptedAt = parseWebhookInstant(raw.acceptedAt);
  const rawEvidenceExpiresAt = parseWebhookInstant(raw.rawEvidenceExpiresAt);
  const dedupeExpiresAt = parseWebhookInstant(raw.dedupeExpiresAt);
  if (
    acceptedAt !== receivedAt ||
    Date.parse(rawEvidenceExpiresAt) - Date.parse(acceptedAt) !== 30 * 86_400_000 ||
    Date.parse(dedupeExpiresAt) - Date.parse(acceptedAt) !== 90 * 86_400_000
  )
    return invalid();
  return Object.freeze({
    webhookReceiptReference: parsePaymentReference(raw.webhookReceiptReference),
    provider: "Stripe",
    environment: raw.environment,
    providerAccountReference: parsePaymentReference(raw.providerAccountReference),
    brandReference: parsePaymentReference(raw.brandReference),
    storeReference: parsePaymentReference(raw.storeReference),
    providerEventReference: parseStripeEventReference(raw.providerEventReference),
    providerEventType: parseStripeEventType(raw.providerEventType),
    providerCreatedAt: parseWebhookInstant(raw.providerCreatedAt),
    receivedAt,
    signatureTimestamp: parseWebhookInstant(raw.signatureTimestamp),
    evidenceDigest: parseWebhookDigest(raw.evidenceDigest),
    acceptedAt,
    rawEvidenceExpiresAt,
    dedupeExpiresAt,
  });
}

export function createPaymentWebhookInboxRecord(
  value: PaymentWebhookReceiptSnapshot & { readonly rawEvidence: Uint8Array },
): PaymentWebhookInboxRecord {
  const { rawEvidence: rawEvidenceInput, ...snapshot } = value;
  const receipt = parsePaymentWebhookReceiptSnapshot(snapshot);
  if (
    !(rawEvidenceInput instanceof Uint8Array) ||
    rawEvidenceInput.byteLength < 1 ||
    rawEvidenceInput.byteLength > 1_048_576
  )
    return invalid();
  const rawEvidence = Uint8Array.from(rawEvidenceInput);
  return Object.freeze({
    ...receipt,
    copyRawEvidence: () => Uint8Array.from(rawEvidence),
  });
}

export function parsePaymentWebhookInboxRecord(value: unknown): PaymentWebhookInboxRecord {
  const raw = exact(value, [...receiptFields, "copyRawEvidence"]);
  if (typeof raw.copyRawEvidence !== "function") return invalid();
  let evidence: unknown;
  try {
    evidence = raw.copyRawEvidence();
  } catch {
    return invalid();
  }
  if (!(evidence instanceof Uint8Array)) return invalid();
  try {
    const { copyRawEvidence: _copyRawEvidence, ...snapshot } = raw;
    void _copyRawEvidence;
    return createPaymentWebhookInboxRecord({
      ...parsePaymentWebhookReceiptSnapshot(snapshot),
      rawEvidence: evidence,
    });
  } finally {
    evidence.fill(0);
  }
}

export function parsePaymentWebhookProcessingCompletion(
  value: unknown,
): PaymentWebhookProcessingCompletion {
  const raw = exact(value, [
    "webhookReceiptReference",
    "consumerName",
    "processedAt",
    "resultDigest",
  ]);
  if (raw.consumerName !== paymentWebhookInboxConsumer) return invalid();
  return Object.freeze({
    webhookReceiptReference: parsePaymentReference(raw.webhookReceiptReference),
    consumerName: paymentWebhookInboxConsumer,
    processedAt: parseWebhookInstant(raw.processedAt),
    resultDigest: parseWebhookDigest(raw.resultDigest),
  });
}

export function cloneVerifiedWebhook(value: unknown) {
  const raw = exact(value, [
    "provider",
    "environment",
    "providerAccountReference",
    "brandReference",
    "storeReference",
    "providerEventReference",
    "providerEventType",
    "providerCreatedAt",
    "receivedAt",
    "signatureTimestamp",
    "evidenceDigest",
    "matchedSecretSlot",
    "copyRawBody",
  ]);
  if (typeof raw.copyRawBody !== "function") return invalid();
  let rawBody: unknown;
  try {
    rawBody = raw.copyRawBody();
  } catch {
    return invalid();
  }
  if (!(rawBody instanceof Uint8Array)) return invalid();
  try {
    return createVerifiedProviderWebhook({
      provider: raw.provider as never,
      environment: raw.environment as never,
      providerAccountReference: parsePaymentReference(raw.providerAccountReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      providerEventReference: parseStripeEventReference(raw.providerEventReference),
      providerEventType: parseStripeEventType(raw.providerEventType),
      providerCreatedAt: parseWebhookInstant(raw.providerCreatedAt),
      receivedAt: parseWebhookInstant(raw.receivedAt),
      signatureTimestamp: parseWebhookInstant(raw.signatureTimestamp),
      evidenceDigest: parseWebhookDigest(raw.evidenceDigest),
      matchedSecretSlot: raw.matchedSecretSlot as never,
      rawBody,
    });
  } finally {
    rawBody.fill(0);
  }
}
