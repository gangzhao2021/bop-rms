import type { PaymentReference } from "../contracts/payment-provider-adapter.js";

export type WebhookInstant = string & { readonly __webhookInstant: unique symbol };
export type WebhookDigest = string & { readonly __webhookDigest: unique symbol };
export type StripeEventReference = string & { readonly __stripeEventReference: unique symbol };
export type StripeEventType = string & { readonly __stripeEventType: unique symbol };

export const providerWebhookVerificationErrorCodes = [
  "PROVIDER_WEBHOOK_INPUT_INVALID",
  "PROVIDER_WEBHOOK_ACCOUNT_NOT_FOUND",
  "PROVIDER_WEBHOOK_CONFIGURATION_INVALID",
  "PROVIDER_WEBHOOK_SIGNATURE_INVALID",
  "PROVIDER_WEBHOOK_TIMESTAMP_INVALID",
  "PROVIDER_WEBHOOK_PAYLOAD_INVALID",
  "PROVIDER_WEBHOOK_SCOPE_MISMATCH",
  "PROVIDER_WEBHOOK_DEPENDENCY_UNAVAILABLE",
] as const;
export type ProviderWebhookVerificationErrorCode =
  (typeof providerWebhookVerificationErrorCodes)[number];

export class ProviderWebhookVerificationError extends Error {
  readonly code: ProviderWebhookVerificationErrorCode;

  constructor(code: ProviderWebhookVerificationErrorCode) {
    super("provider webhook verification failed");
    this.name = "ProviderWebhookVerificationError";
    this.code = code;
  }
}

function invalid(
  code: ProviderWebhookVerificationErrorCode = "PROVIDER_WEBHOOK_INPUT_INVALID",
): never {
  throw new ProviderWebhookVerificationError(code);
}

export function exactWebhookObject(
  value: unknown,
  fields: readonly string[],
  code: ProviderWebhookVerificationErrorCode = "PROVIDER_WEBHOOK_INPUT_INVALID",
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid(code);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid(code);
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid(code);
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof ProviderWebhookVerificationError) throw error;
    return invalid(code);
  }
}

export function parseWebhookInstant(value: unknown): WebhookInstant {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value as WebhookInstant;
}

export function parseWebhookDigest(value: unknown): WebhookDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return invalid();
  return value as WebhookDigest;
}

export function parseStripeEventReference(value: unknown): StripeEventReference {
  if (typeof value !== "string" || !/^evt_[A-Za-z0-9]{8,128}$/u.test(value)) return invalid();
  return value as StripeEventReference;
}

export function parseStripeEventType(value: unknown): StripeEventType {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u.test(value)
  )
    return invalid();
  return value as StripeEventType;
}

export interface VerifiedProviderWebhook {
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
  readonly matchedSecretSlot: "Current" | "Next";
  copyRawBody(): Uint8Array;
}

export function createVerifiedProviderWebhook(
  value: Omit<VerifiedProviderWebhook, "copyRawBody"> & { readonly rawBody: Uint8Array },
): VerifiedProviderWebhook {
  const rawBody = Uint8Array.from(value.rawBody);
  const result = {
    provider: value.provider,
    environment: value.environment,
    providerAccountReference: value.providerAccountReference,
    brandReference: value.brandReference,
    storeReference: value.storeReference,
    providerEventReference: parseStripeEventReference(value.providerEventReference),
    providerEventType: parseStripeEventType(value.providerEventType),
    providerCreatedAt: parseWebhookInstant(value.providerCreatedAt),
    receivedAt: parseWebhookInstant(value.receivedAt),
    signatureTimestamp: parseWebhookInstant(value.signatureTimestamp),
    evidenceDigest: parseWebhookDigest(value.evidenceDigest),
    matchedSecretSlot: value.matchedSecretSlot,
    copyRawBody: () => Uint8Array.from(rawBody),
  } satisfies VerifiedProviderWebhook;
  if (
    result.provider !== "Stripe" ||
    (result.environment !== "Test" && result.environment !== "Live") ||
    (result.matchedSecretSlot !== "Current" && result.matchedSecretSlot !== "Next") ||
    rawBody.byteLength < 1 ||
    rawBody.byteLength > 1_048_576
  )
    return invalid("PROVIDER_WEBHOOK_PAYLOAD_INVALID");
  return Object.freeze(result);
}
