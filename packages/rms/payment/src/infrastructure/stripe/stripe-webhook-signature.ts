import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  parseWebhookDigest,
  parseWebhookInstant,
  ProviderWebhookVerificationError,
  type WebhookInstant,
} from "../../application/provider-webhook-verification.js";
import type {
  StripeWebhookSecretConfiguration,
  StripeWebhookSignatureVerification,
} from "../../application/ports/provider-webhook-verification-ports.js";

const maximumBodyBytes = 1_048_576;
const maximumHeaderBytes = 8_192;
const toleranceMilliseconds = 300_000;
const maximumOverlapMilliseconds = 7 * 24 * 60 * 60 * 1_000;

function fail(code: ConstructorParameters<typeof ProviderWebhookVerificationError>[0]): never {
  throw new ProviderWebhookVerificationError(code);
}

function parseHeader(value: string): { timestamp: number; signatures: readonly Buffer[] } {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "ascii") !== value.length ||
    value.length > maximumHeaderBytes ||
    !/^[\x21-\x7e]+$/u.test(value)
  )
    return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
  const entries = value.split(",");
  if (entries.length < 2 || entries.length > 16) return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1 || entry.indexOf("=", separator + 1) >= 0)
      return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
    const scheme = entry.slice(0, separator);
    const data = entry.slice(separator + 1);
    if (!/^[a-z][a-z0-9]*$/u.test(scheme)) return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
    if (scheme === "t") {
      if (timestamp !== null || !/^[1-9][0-9]{0,11}$/u.test(data))
        return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
      timestamp = Number(data);
      if (!Number.isSafeInteger(timestamp)) return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
    } else if (scheme === "v1") {
      if (!/^[0-9a-f]{64}$/u.test(data) || signatures.length >= 8)
        return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
      signatures.push(Buffer.from(data, "hex"));
    } else if (!/^[A-Za-z0-9]{1,256}$/u.test(data)) {
      return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
    }
  }
  if (timestamp === null || signatures.length === 0)
    return fail("PROVIDER_WEBHOOK_SIGNATURE_INVALID");
  return { timestamp, signatures: Object.freeze(signatures) };
}

function secret(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 16 || value.byteLength > 256)
    return fail("PROVIDER_WEBHOOK_CONFIGURATION_INVALID");
  return Buffer.from(value);
}

function matches(signatures: readonly Buffer[], expected: Buffer): boolean {
  let matched = false;
  for (const signature of signatures) matched = timingSafeEqual(signature, expected) || matched;
  return matched;
}

export function verifyStripeWebhookSignature(input: {
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string;
  readonly receivedAt: WebhookInstant;
  readonly configuration: StripeWebhookSecretConfiguration;
}): StripeWebhookSignatureVerification {
  let current: Buffer | undefined;
  let next: Buffer | undefined;
  let signed: Buffer | undefined;
  let currentDigest: Buffer | undefined;
  let nextDigest: Buffer | undefined;
  try {
    if (
      !(input.rawBody instanceof Uint8Array) ||
      input.rawBody.byteLength < 1 ||
      input.rawBody.byteLength > maximumBodyBytes
    )
      return fail("PROVIDER_WEBHOOK_INPUT_INVALID");
    const receivedAt = parseWebhookInstant(input.receivedAt);
    const header = parseHeader(input.signatureHeader);
    const timestampMilliseconds = header.timestamp * 1_000;
    if (Math.abs(Date.parse(receivedAt) - timestampMilliseconds) > toleranceMilliseconds)
      return fail("PROVIDER_WEBHOOK_TIMESTAMP_INVALID");
    current = secret(input.configuration.currentSecret);
    signed = Buffer.concat([
      Buffer.from(String(header.timestamp), "ascii"),
      Buffer.from(".", "ascii"),
      Buffer.from(input.rawBody),
    ]);
    currentDigest = createHmac("sha256", current).update(signed).digest();
    let matchedSecretSlot: "Current" | "Next" | null = matches(header.signatures, currentDigest)
      ? "Current"
      : null;
    const rotation = input.configuration.nextSecret;
    if (rotation !== null) {
      const validFrom = Date.parse(parseWebhookInstant(rotation.validFrom));
      const validUntil = Date.parse(parseWebhookInstant(rotation.validUntil));
      if (
        validUntil < validFrom ||
        validUntil - validFrom > maximumOverlapMilliseconds ||
        timingSafeEqual(
          createHash("sha256").update(input.configuration.currentSecret).digest(),
          createHash("sha256").update(rotation.secret).digest(),
        )
      )
        return fail("PROVIDER_WEBHOOK_CONFIGURATION_INVALID");
      next = secret(rotation.secret);
      const received = Date.parse(receivedAt);
      if (received >= validFrom && received <= validUntil) {
        nextDigest = createHmac("sha256", next).update(signed).digest();
        if (matches(header.signatures, nextDigest)) matchedSecretSlot = "Next";
      }
    }
    if (matchedSecretSlot === null) return fail("PROVIDER_WEBHOOK_SIGNATURE_INVALID");
    return Object.freeze({
      signatureTimestamp: parseWebhookInstant(new Date(timestampMilliseconds).toISOString()),
      evidenceDigest: parseWebhookDigest(
        `sha256:${createHash("sha256").update(input.rawBody).digest("hex")}`,
      ),
      matchedSecretSlot,
    });
  } catch (error) {
    if (error instanceof ProviderWebhookVerificationError) throw error;
    return fail("PROVIDER_WEBHOOK_SIGNATURE_INVALID");
  } finally {
    current?.fill(0);
    next?.fill(0);
    signed?.fill(0);
    currentDigest?.fill(0);
    nextDigest?.fill(0);
    input.configuration.currentSecret.fill(0);
    input.configuration.nextSecret?.secret.fill(0);
  }
}
