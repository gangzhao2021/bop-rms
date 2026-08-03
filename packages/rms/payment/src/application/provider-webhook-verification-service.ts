import { parsePaymentReference } from "./payment-provider-adapter.js";
import type { PaymentReference } from "../contracts/payment-provider-adapter.js";
import {
  createVerifiedProviderWebhook,
  exactWebhookObject,
  parseStripeEventReference,
  parseStripeEventType,
  parseWebhookInstant,
  ProviderWebhookVerificationError,
  type ProviderWebhookVerificationErrorCode,
  type VerifiedProviderWebhook,
  type WebhookDigest,
  type WebhookInstant,
} from "./provider-webhook-verification.js";
import type {
  ProviderWebhookVerificationPorts,
  StripeWebhookSecretConfiguration,
} from "./ports/provider-webhook-verification-ports.js";

function fail(code: ProviderWebhookVerificationErrorCode): never {
  throw new ProviderWebhookVerificationError(code);
}

function dependency(error: unknown): never {
  if (error instanceof ProviderWebhookVerificationError) throw error;
  return fail("PROVIDER_WEBHOOK_DEPENDENCY_UNAVAILABLE");
}

function environment(value: unknown): "Test" | "Live" {
  if (value !== "Test" && value !== "Live") return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
  return value;
}

function body(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 1_048_576)
    return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
  return Uint8Array.from(value);
}

function header(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192)
    return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
  return value;
}

function safeZero(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
}

function configuration(
  value: unknown,
  expected: {
    environment: "Test" | "Live";
    providerAccountReference: PaymentReference;
  },
): StripeWebhookSecretConfiguration {
  const raw = exactWebhookObject(
    value,
    [
      "provider",
      "environment",
      "providerAccountReference",
      "brandReference",
      "storeReference",
      "currentSecret",
      "nextSecret",
    ],
    "PROVIDER_WEBHOOK_CONFIGURATION_INVALID",
  );
  let account: PaymentReference;
  let brand: PaymentReference;
  let store: PaymentReference;
  try {
    account = parsePaymentReference(raw.providerAccountReference);
    brand = parsePaymentReference(raw.brandReference);
    store = parsePaymentReference(raw.storeReference);
  } catch {
    return fail("PROVIDER_WEBHOOK_CONFIGURATION_INVALID");
  }
  if (
    raw.provider !== "Stripe" ||
    raw.environment !== expected.environment ||
    account !== expected.providerAccountReference ||
    !(raw.currentSecret instanceof Uint8Array)
  )
    return fail("PROVIDER_WEBHOOK_CONFIGURATION_INVALID");
  let nextSecret: StripeWebhookSecretConfiguration["nextSecret"] = null;
  if (raw.nextSecret !== null) {
    const next = exactWebhookObject(
      raw.nextSecret,
      ["secret", "validFrom", "validUntil"],
      "PROVIDER_WEBHOOK_CONFIGURATION_INVALID",
    );
    if (!(next.secret instanceof Uint8Array)) return fail("PROVIDER_WEBHOOK_CONFIGURATION_INVALID");
    try {
      nextSecret = {
        secret: next.secret,
        validFrom: parseWebhookInstant(next.validFrom),
        validUntil: parseWebhookInstant(next.validUntil),
      };
    } catch {
      return fail("PROVIDER_WEBHOOK_CONFIGURATION_INVALID");
    }
  }
  return {
    provider: "Stripe",
    environment: expected.environment,
    providerAccountReference: account,
    brandReference: brand,
    storeReference: store,
    currentSecret: raw.currentSecret,
    nextSecret,
  };
}

function eventEnvelope(
  rawBody: Uint8Array,
  environmentValue: "Test" | "Live",
): {
  providerEventReference: ReturnType<typeof parseStripeEventReference>;
  providerEventType: ReturnType<typeof parseStripeEventType>;
  providerCreatedAt: WebhookInstant;
} {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return fail("PROVIDER_WEBHOOK_PAYLOAD_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const data = (field: string): unknown => {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor))
        return fail("PROVIDER_WEBHOOK_PAYLOAD_INVALID");
      return descriptor.value;
    };
    const created = data("created");
    const livemode = data("livemode");
    if (
      data("object") !== "event" ||
      !Number.isSafeInteger(created) ||
      (created as number) < 1 ||
      typeof livemode !== "boolean" ||
      livemode !== (environmentValue === "Live")
    )
      return fail("PROVIDER_WEBHOOK_SCOPE_MISMATCH");
    return {
      providerEventReference: parseStripeEventReference(data("id")),
      providerEventType: parseStripeEventType(data("type")),
      providerCreatedAt: parseWebhookInstant(new Date((created as number) * 1_000).toISOString()),
    };
  } catch (error) {
    if (error instanceof ProviderWebhookVerificationError) throw error;
    return fail("PROVIDER_WEBHOOK_PAYLOAD_INVALID");
  }
}

async function audit(
  ports: ProviderWebhookVerificationPorts,
  config: StripeWebhookSecretConfiguration,
  input: {
    receivedAt: WebhookInstant;
    outcome: "Verified" | "Rejected";
    reasonCode: "SIGNATURE_VERIFIED" | ProviderWebhookVerificationErrorCode;
    evidenceDigest: WebhookDigest | null;
  },
): Promise<void> {
  await ports.securityAudit
    .record({
      provider: "Stripe",
      environment: config.environment,
      providerAccountReference: config.providerAccountReference,
      brandReference: config.brandReference,
      storeReference: config.storeReference,
      receivedAt: input.receivedAt,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      evidenceDigest: input.evidenceDigest,
    })
    .catch(() => fail("PROVIDER_WEBHOOK_DEPENDENCY_UNAVAILABLE"));
}

export function createProviderWebhookVerificationService(ports: ProviderWebhookVerificationPorts) {
  return Object.freeze({
    async verify(value: unknown): Promise<VerifiedProviderWebhook> {
      const raw = exactWebhookObject(value, [
        "provider",
        "environment",
        "providerAccountReference",
        "receivedAt",
        "signatureHeader",
        "rawBody",
      ]);
      if (raw.provider !== "Stripe") return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
      const environmentValue = environment(raw.environment);
      let providerAccountReference: PaymentReference;
      try {
        providerAccountReference = parsePaymentReference(raw.providerAccountReference);
      } catch {
        return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
      }
      const receivedAt = parseWebhookInstant(raw.receivedAt);
      const signatureHeader = header(raw.signatureHeader);
      const rawBody = body(raw.rawBody);
      let resolved: unknown;
      try {
        resolved = await ports.configuration.resolve({
          provider: "Stripe",
          environment: environmentValue,
          providerAccountReference,
          receivedAt,
        });
      } catch (error) {
        rawBody.fill(0);
        return dependency(error);
      }
      if (resolved === null) {
        rawBody.fill(0);
        return fail("PROVIDER_WEBHOOK_ACCOUNT_NOT_FOUND");
      }
      let config: StripeWebhookSecretConfiguration;
      try {
        config = configuration(resolved, {
          environment: environmentValue,
          providerAccountReference,
        });
      } catch (error) {
        if (resolved !== null && typeof resolved === "object") {
          const descriptors = Object.getOwnPropertyDescriptors(resolved);
          safeZero(descriptors.currentSecret?.value);
          const next = descriptors.nextSecret?.value;
          if (next !== null && typeof next === "object")
            safeZero(Object.getOwnPropertyDescriptors(next).secret?.value);
        }
        rawBody.fill(0);
        throw error;
      }
      let evidenceDigest: WebhookDigest | null = null;
      try {
        const verified = ports.signature.verify({
          rawBody,
          signatureHeader,
          receivedAt,
          configuration: config,
        });
        evidenceDigest = verified.evidenceDigest;
        const envelope = eventEnvelope(rawBody, environmentValue);
        const result = createVerifiedProviderWebhook({
          provider: "Stripe",
          environment: environmentValue,
          providerAccountReference,
          brandReference: config.brandReference,
          storeReference: config.storeReference,
          ...envelope,
          receivedAt,
          signatureTimestamp: verified.signatureTimestamp,
          evidenceDigest,
          matchedSecretSlot: verified.matchedSecretSlot,
          rawBody,
        });
        await audit(ports, config, {
          receivedAt,
          outcome: "Verified",
          reasonCode: "SIGNATURE_VERIFIED",
          evidenceDigest,
        });
        return result;
      } catch (error) {
        const normalized =
          error instanceof ProviderWebhookVerificationError
            ? error
            : new ProviderWebhookVerificationError("PROVIDER_WEBHOOK_SIGNATURE_INVALID");
        await audit(ports, config, {
          receivedAt,
          outcome: "Rejected",
          reasonCode: normalized.code,
          evidenceDigest,
        });
        throw normalized;
      } finally {
        rawBody.fill(0);
        safeZero(config.currentSecret);
        safeZero(config.nextSecret?.secret);
      }
    },
  });
}
