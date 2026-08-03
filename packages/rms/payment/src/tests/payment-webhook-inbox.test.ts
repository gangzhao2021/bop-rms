import { createHash, timingSafeEqual } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createPaymentWebhookInboxService } from "../application/payment-webhook-inbox-service.js";
import {
  parsePaymentWebhookInboxRecord,
  PaymentWebhookInboxError,
  paymentWebhookInboxConsumer,
  type PaymentWebhookInboxRecord,
  type PaymentWebhookProcessingCompletion,
} from "../application/payment-webhook-inbox.js";
import { createVerifiedProviderWebhook } from "../application/provider-webhook-verification.js";
import type { PaymentWebhookInboxPorts } from "../application/ports/payment-webhook-inbox-ports.js";

const id = (n: number) => `0198a005-0000-7000-8000-${n.toString(16).padStart(12, "0")}` as const;
const receivedAt = "2026-08-03T17:00:00.000Z" as const;
const processedAt = "2026-08-03T17:01:00.000Z" as const;
const body = (event = "evt_SYNTHETIC1304", created = 1_775_057_700) =>
  new TextEncoder().encode(
    JSON.stringify({ id: event, object: "event", type: "payment_intent.succeeded", created }),
  );
const digest = (value: Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as const;

function verified(
  overrides: {
    event?: string;
    account?: string;
    brand?: string;
    store?: string;
    raw?: Uint8Array;
    evidenceDigest?: string;
    receivedAt?: string;
  } = {},
) {
  const raw = overrides.raw ?? body(overrides.event);
  return createVerifiedProviderWebhook({
    provider: "Stripe",
    environment: "Test",
    providerAccountReference: (overrides.account ?? id(1)) as never,
    brandReference: (overrides.brand ?? id(2)) as never,
    storeReference: (overrides.store ?? id(3)) as never,
    providerEventReference: (overrides.event ?? "evt_SYNTHETIC1304") as never,
    providerEventType: "payment_intent.succeeded" as never,
    providerCreatedAt: "2026-08-03T16:55:00.000Z" as never,
    receivedAt: (overrides.receivedAt ?? receivedAt) as never,
    signatureTimestamp: "2026-08-03T16:59:59.000Z" as never,
    evidenceDigest: (overrides.evidenceDigest ?? digest(raw)) as never,
    matchedSecretSlot: "Current",
    rawBody: raw,
  });
}

function repository() {
  const byKey = new Map<string, PaymentWebhookInboxRecord>();
  const byReference = new Map<string, PaymentWebhookInboxRecord>();
  const completions = new Map<string, PaymentWebhookProcessingCompletion>();
  const processing = new Map<string, Promise<PaymentWebhookProcessingCompletion>>();
  const key = (record: PaymentWebhookInboxRecord) =>
    [
      record.provider,
      record.environment,
      record.providerAccountReference,
      record.providerEventReference,
    ].join(":");
  return {
    byKey,
    byReference,
    completions,
    port: {
      async accept({ record }: { readonly record: PaymentWebhookInboxRecord }) {
        const proposed = parsePaymentWebhookInboxRecord(record);
        const prior = byKey.get(key(proposed));
        if (prior !== undefined)
          return {
            status: prior.evidenceDigest === proposed.evidenceDigest ? "Duplicate" : "Conflict",
            record: prior,
          } as const;
        byKey.set(key(proposed), proposed);
        byReference.set(proposed.webhookReceiptReference, proposed);
        return { status: "Accepted", record: proposed } as const;
      },
      async process(input: {
        readonly webhookReceiptReference: string;
        readonly consumerName: typeof paymentWebhookInboxConsumer;
        readonly requestedAt: string;
        readonly handler: (record: PaymentWebhookInboxRecord) => Promise<string>;
      }) {
        const completionKey = `${input.webhookReceiptReference}:${input.consumerName}`;
        const completed = completions.get(completionKey);
        if (completed !== undefined)
          return { status: "AlreadyCompleted", completion: completed } as const;
        const current = processing.get(completionKey);
        if (current !== undefined)
          return { status: "AlreadyCompleted", completion: await current } as const;
        const record = byReference.get(input.webhookReceiptReference);
        if (record === undefined) return { status: "NotFound" } as const;
        const work = (async () => {
          const resultDigest = await input.handler(record);
          const completion = Object.freeze({
            webhookReceiptReference: record.webhookReceiptReference,
            consumerName: paymentWebhookInboxConsumer,
            processedAt: processedAt as never,
            resultDigest: resultDigest as never,
          });
          completions.set(completionKey, completion);
          return completion;
        })();
        processing.set(completionKey, work);
        try {
          return { status: "Completed", completion: await work } as const;
        } finally {
          processing.delete(completionKey);
        }
      },
    },
  };
}

function fixture(options: { mapper?: PaymentWebhookInboxPorts["mapper"] } = {}) {
  const storage = repository();
  let sequence = 100;
  const mapper =
    options.mapper ??
    ({
      process: vi.fn(async ({ rawEvidence }) => ({ resultDigest: digest(rawEvidence) })),
    } satisfies PaymentWebhookInboxPorts["mapper"]);
  const ports: PaymentWebhookInboxPorts = {
    references: {
      generateReceipt: () => id(sequence++),
      hashEvidence: digest,
      equalsDigest: (left, right) => {
        const a = Buffer.from(left);
        const b = Buffer.from(right);
        return a.byteLength === b.byteLength && timingSafeEqual(a, b);
      },
    },
    repository: storage.port as PaymentWebhookInboxPorts["repository"],
    mapper,
  };
  return { service: createPaymentWebhookInboxService(ports), storage, mapper, ports };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "PaymentWebhookInboxError", code });
}

describe("WP-1304 Payment webhook Inbox", () => {
  it("durably accepts before returning an acknowledgement with bounded retention", async () => {
    const { service, storage } = fixture();
    const result = await service.accept(verified());
    expect(result).toMatchObject({ status: "Accepted", disposition: "Acknowledge" });
    expect(result.receipt.rawEvidenceExpiresAt).toBe("2026-09-02T17:00:00.000Z");
    expect(result.receipt.dedupeExpiresAt).toBe("2026-11-01T17:00:00.000Z");
    expect(storage.byKey.size).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/copyRaw|matchedSecretSlot|"object":"event"|whsec/u);
  });

  it("returns the original receipt for a matching sequential duplicate", async () => {
    const { service, storage } = fixture();
    const first = await service.accept(verified());
    const second = await service.accept(verified());
    expect(second.status).toBe("Duplicate");
    expect(second.receipt.webhookReceiptReference).toBe(first.receipt.webhookReceiptReference);
    expect(storage.byKey.size).toBe(1);
  });

  it("atomically reduces concurrent matching deliveries to one receipt", async () => {
    const { service, storage } = fixture();
    const results = await Promise.all([service.accept(verified()), service.accept(verified())]);
    expect(results.map((result) => result.status).sort()).toEqual(["Accepted", "Duplicate"]);
    expect(storage.byKey.size).toBe(1);
  });

  it("rejects same account and Event ID with conflicting immutable evidence", async () => {
    const { service, storage } = fixture();
    await service.accept(verified());
    const changed = body();
    const changedIndex = changed.byteLength - 2;
    changed[changedIndex] = (changed[changedIndex] ?? 0) ^ 1;
    await expectCode(
      service.accept(verified({ raw: changed })),
      "PAYMENT_WEBHOOK_INBOX_IDENTITY_CONFLICT",
    );
    expect(storage.byKey.size).toBe(1);
  });

  it("re-hashes raw evidence and rejects a mutated verifier result before persistence", async () => {
    const { service, storage } = fixture();
    await expectCode(
      service.accept(verified({ evidenceDigest: `sha256:${"0".repeat(64)}` })),
      "PAYMENT_WEBHOOK_INBOX_EVIDENCE_MISMATCH",
    );
    expect(storage.byKey.size).toBe(0);
  });

  it("keeps Provider Account and environment inside the dedupe identity", async () => {
    const { service, storage } = fixture();
    await service.accept(verified());
    await service.accept(verified({ account: id(4) }));
    await service.accept(verified({ event: "evt_SYNTHETIC1305", raw: body("evt_SYNTHETIC1305") }));
    expect(storage.byKey.size).toBe(3);
  });

  it("commits one mapper result and returns it without replaying the effect", async () => {
    const { service, mapper } = fixture();
    const accepted = await service.accept(verified());
    const first = await service.process({
      webhookReceiptReference: accepted.receipt.webhookReceiptReference,
      requestedAt: processedAt,
    });
    const replay = await service.process({
      webhookReceiptReference: accepted.receipt.webhookReceiptReference,
      requestedAt: processedAt,
    });
    expect(first.status).toBe("Completed");
    expect(replay.status).toBe("AlreadyCompleted");
    expect(mapper.process).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent processing and clears the temporary mapper byte copy", async () => {
    let retained: Uint8Array | undefined;
    const mapper = {
      process: vi.fn(async ({ rawEvidence }: { rawEvidence: Uint8Array }) => {
        retained = rawEvidence;
        await Promise.resolve();
        return { resultDigest: digest(rawEvidence) };
      }),
    };
    const { service } = fixture({ mapper });
    const accepted = await service.accept(verified());
    const input = {
      webhookReceiptReference: accepted.receipt.webhookReceiptReference,
      requestedAt: processedAt,
    };
    const results = await Promise.all([service.process(input), service.process(input)]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "AlreadyCompleted",
      "Completed",
    ]);
    expect(mapper.process).toHaveBeenCalledTimes(1);
    expect(retained).toBeDefined();
    expect(retained?.every((byte) => byte === 0)).toBe(true);
  });

  it("rolls back a failed mapper attempt and permits the same receipt to replay", async () => {
    let calls = 0;
    const mapper = {
      process: vi.fn(async ({ rawEvidence }: { rawEvidence: Uint8Array }) => {
        calls += 1;
        if (calls === 1) throw new Error("synthetic provider detail must not escape");
        return { resultDigest: digest(rawEvidence) };
      }),
    };
    const { service, storage } = fixture({ mapper });
    const accepted = await service.accept(verified());
    const input = {
      webhookReceiptReference: accepted.receipt.webhookReceiptReference,
      requestedAt: processedAt,
    };
    await expectCode(service.process(input), "PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
    expect(storage.completions.size).toBe(0);
    expect((await service.process(input)).status).toBe("Completed");
    expect(storage.completions.size).toBe(1);
  });

  it("processes later and earlier Provider timestamps independently", async () => {
    const { service, mapper } = fixture();
    const later = await service.accept(
      verified({ event: "evt_SYNTHETIC1306", raw: body("evt_SYNTHETIC1306", 1_775_057_800) }),
    );
    const earlier = await service.accept(
      verified({ event: "evt_SYNTHETIC1307", raw: body("evt_SYNTHETIC1307", 1_775_057_600) }),
    );
    await service.process({
      webhookReceiptReference: later.receipt.webhookReceiptReference,
      requestedAt: processedAt,
    });
    await service.process({
      webhookReceiptReference: earlier.receipt.webhookReceiptReference,
      requestedAt: processedAt,
    });
    expect(mapper.process).toHaveBeenCalledTimes(2);
  });

  it("fails closed for an unknown receipt and exposes only a stable code", async () => {
    const { service } = fixture();
    try {
      await service.process({ webhookReceiptReference: id(999), requestedAt: processedAt });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentWebhookInboxError);
      expect(error).toMatchObject({ code: "PAYMENT_WEBHOOK_INBOX_NOT_FOUND" });
      expect(String(error)).not.toContain(id(999));
    }
  });

  it("returns no acknowledgement when durable acceptance is unavailable", async () => {
    const { service, ports } = fixture();
    ports.repository.accept = vi.fn(async () => {
      throw new Error("database details");
    });
    await expectCode(service.accept(verified()), "PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
  });
});
