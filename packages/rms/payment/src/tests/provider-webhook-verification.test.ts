import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createProviderWebhookVerificationService } from "../application/provider-webhook-verification-service.js";
import { ProviderWebhookVerificationError } from "../application/provider-webhook-verification.js";
import type {
  ProviderWebhookVerificationPorts,
  StripeWebhookSecretConfiguration,
} from "../application/ports/provider-webhook-verification-ports.js";
import { verifyStripeWebhookSignature } from "../infrastructure/stripe/stripe-webhook-signature.js";

const account = "01890f47-2f7d-7cc2-98b1-9b4f680a8f21" as never;
const brand = "01890f47-2f7d-7cc2-98b1-9b4f680a8f22" as never;
const store = "01890f47-2f7d-7cc2-98b1-9b4f680a8f23" as never;
const receivedAt = "2026-08-03T15:00:00.000Z" as never;
const timestamp = Date.parse(receivedAt) / 1_000;
const currentText = "whsec_synthetic_current_1303";
const nextText = "whsec_synthetic_next_1303";
const encoder = new TextEncoder();

function event(livemode = false): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      id: "evt_synthetic1303",
      object: "event",
      type: "payment_intent.succeeded",
      created: timestamp - 10,
      livemode,
      data: { object: { prohibited: "opaque" } },
    }),
  );
}

function signature(rawBody: Uint8Array, secret: string, at = timestamp): string {
  const digest = createHmac("sha256", secret)
    .update(Buffer.from(`${at}.`, "ascii"))
    .update(rawBody)
    .digest("hex");
  return `t=${at},v1=${digest}`;
}

function config(
  overrides: Partial<StripeWebhookSecretConfiguration> = {},
): StripeWebhookSecretConfiguration {
  return {
    provider: "Stripe",
    environment: "Test",
    providerAccountReference: account,
    brandReference: brand,
    storeReference: store,
    currentSecret: encoder.encode(currentText),
    nextSecret: null,
    ...overrides,
  };
}

function harness(
  options: {
    configuration?: () => StripeWebhookSecretConfiguration | null;
    auditReject?: boolean;
  } = {},
) {
  const audits: unknown[] = [];
  const issuedConfigurations: StripeWebhookSecretConfiguration[] = [];
  const ports: ProviderWebhookVerificationPorts = {
    configuration: {
      async resolve() {
        const value = options.configuration?.() ?? config();
        if (value !== null) issuedConfigurations.push(value);
        return value;
      },
    },
    signature: { verify: verifyStripeWebhookSignature },
    securityAudit: {
      async record(input) {
        if (options.auditReject) throw new Error("synthetic audit detail");
        audits.push(input);
      },
    },
  };
  return {
    audits,
    issuedConfigurations,
    service: createProviderWebhookVerificationService(ports),
  };
}

function command(rawBody = event(), signatureHeader = signature(rawBody, currentText)) {
  return {
    provider: "Stripe",
    environment: "Test",
    providerAccountReference: account,
    receivedAt,
    signatureHeader,
    rawBody,
  };
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: "ProviderWebhookVerificationError",
    code,
    message: "provider webhook verification failed",
  });
}

describe("WP-1303 Provider webhook verification", () => {
  it("verifies exact raw bytes and returns an immutable safe envelope", async () => {
    const rawBody = event();
    const input = command(rawBody);
    const { service, audits, issuedConfigurations } = harness();
    const verified = await service.verify(input);
    expect(verified).toMatchObject({
      provider: "Stripe",
      environment: "Test",
      providerAccountReference: account,
      brandReference: brand,
      storeReference: store,
      providerEventReference: "evt_synthetic1303",
      providerEventType: "payment_intent.succeeded",
      receivedAt,
      signatureTimestamp: receivedAt,
      matchedSecretSlot: "Current",
    });
    expect(Object.isFrozen(verified)).toBe(true);
    const first = verified.copyRawBody();
    first.fill(0);
    expect(verified.copyRawBody()).toEqual(rawBody);
    expect(input.rawBody).toEqual(rawBody);
    expect(issuedConfigurations[0]?.currentSecret.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(verified)).not.toMatch(/signatureHeader|secret|prohibited|whsec/u);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: "Verified",
      reasonCode: "SIGNATURE_VERIFIED",
    });
  });

  it("rejects a one-byte raw-body change before payload interpretation", async () => {
    const original = event();
    const changed = Uint8Array.from(original);
    const last = changed.length - 1;
    const finalByte = changed[last];
    if (finalByte === undefined) throw new Error("synthetic body is unexpectedly empty");
    changed[last] = finalByte ^ 1;
    const { service, audits } = harness();
    await rejectsCode(
      service.verify(command(changed, signature(original, currentText))),
      "PROVIDER_WEBHOOK_SIGNATURE_INVALID",
    );
    expect(audits).toMatchObject([
      { outcome: "Rejected", reasonCode: "PROVIDER_WEBHOOK_SIGNATURE_INVALID" },
    ]);
  });

  it("does not parse invalid JSON until after a valid signature", async () => {
    const rawBody = encoder.encode("{not-json");
    const { service, audits } = harness();
    await rejectsCode(
      service.verify(command(rawBody, signature(rawBody, currentText))),
      "PROVIDER_WEBHOOK_PAYLOAD_INVALID",
    );
    expect(audits[0]).toMatchObject({
      outcome: "Rejected",
      reasonCode: "PROVIDER_WEBHOOK_PAYLOAD_INVALID",
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it.each([-300, 300])(
    "accepts the inclusive five-minute boundary at %s seconds",
    async (delta) => {
      const at = timestamp + delta;
      const rawBody = event();
      await expect(
        harness().service.verify(command(rawBody, signature(rawBody, currentText, at))),
      ).resolves.toMatchObject({ signatureTimestamp: new Date(at * 1_000).toISOString() });
    },
  );

  it.each([-301, 301])(
    "rejects timestamps outside the five-minute window at %s seconds",
    async (delta) => {
      const at = timestamp + delta;
      const rawBody = event();
      await rejectsCode(
        harness().service.verify(command(rawBody, signature(rawBody, currentText, at))),
        "PROVIDER_WEBHOOK_TIMESTAMP_INVALID",
      );
    },
  );

  it("accepts the next secret only inside a maximum seven-day overlap", async () => {
    const rawBody = event();
    const { service, issuedConfigurations } = harness({
      configuration: () =>
        config({
          nextSecret: {
            secret: encoder.encode(nextText),
            validFrom: "2026-08-01T00:00:00.000Z" as never,
            validUntil: "2026-08-07T23:59:59.000Z" as never,
          },
        }),
    });
    await expect(
      service.verify(command(rawBody, signature(rawBody, nextText))),
    ).resolves.toMatchObject({ matchedSecretSlot: "Next" });
    expect(issuedConfigurations[0]?.nextSecret?.secret.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects a secret overlap longer than seven days", async () => {
    const rawBody = event();
    const { service } = harness({
      configuration: () =>
        config({
          nextSecret: {
            secret: encoder.encode(nextText),
            validFrom: "2026-08-01T00:00:00.000Z" as never,
            validUntil: "2026-08-08T00:00:00.001Z" as never,
          },
        }),
    });
    await rejectsCode(
      service.verify(command(rawBody, signature(rawBody, nextText))),
      "PROVIDER_WEBHOOK_CONFIGURATION_INVALID",
    );
  });

  it("does not accept the next secret outside its declared overlap", async () => {
    const rawBody = event();
    const { service } = harness({
      configuration: () =>
        config({
          nextSecret: {
            secret: encoder.encode(nextText),
            validFrom: "2026-08-03T15:00:00.001Z" as never,
            validUntil: "2026-08-07T00:00:00.000Z" as never,
          },
        }),
    });
    await rejectsCode(
      service.verify(command(rawBody, signature(rawBody, nextText))),
      "PROVIDER_WEBHOOK_SIGNATURE_INVALID",
    );
  });

  it.each([
    ["duplicate timestamp", `t=${timestamp},t=${timestamp},v1=${"0".repeat(64)}`],
    ["uppercase digest", `t=${timestamp},v1=${"A".repeat(64)}`],
    [
      "too many signatures",
      `t=${timestamp},${Array(9)
        .fill(`v1=${"0".repeat(64)}`)
        .join(",")}`,
    ],
    ["missing signature", `t=${timestamp},v0=${"0".repeat(64)}`],
  ])("rejects bounded header case: %s", async (_name, signatureHeader) => {
    await expect(
      harness().service.verify(command(event(), signatureHeader)),
    ).rejects.toBeInstanceOf(ProviderWebhookVerificationError);
  });

  it("rejects Test/Live payload mismatch after signature verification", async () => {
    const rawBody = event(true);
    await rejectsCode(
      harness().service.verify(command(rawBody, signature(rawBody, currentText))),
      "PROVIDER_WEBHOOK_SCOPE_MISMATCH",
    );
  });

  it("fails closed for account/configuration mismatch and clears transferred secrets", async () => {
    const issued = config({ providerAccountReference: brand });
    const { service } = harness({ configuration: () => issued });
    await rejectsCode(service.verify(command()), "PROVIDER_WEBHOOK_CONFIGURATION_INVALID");
    expect(issued.currentSecret.every((byte) => byte === 0)).toBe(true);
  });

  it("bounds the raw body before any configuration read", async () => {
    let reads = 0;
    const { service } = harness({
      configuration: () => {
        reads += 1;
        return config();
      },
    });
    await rejectsCode(
      service.verify(command(new Uint8Array(1_048_577), "t=1,v1=" + "0".repeat(64))),
      "PROVIDER_WEBHOOK_INPUT_INVALID",
    );
    expect(reads).toBe(0);
  });

  it("normalizes audit failure without leaking secret or Provider detail", async () => {
    const error = await harness({ auditReject: true })
      .service.verify(command())
      .catch((value) => value);
    expect(error).toMatchObject({ code: "PROVIDER_WEBHOOK_DEPENDENCY_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toMatch(/whsec|synthetic audit detail|signatureHeader/u);
  });
});
