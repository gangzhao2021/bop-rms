import { createMoney, parseCurrencyCode } from "@rms/pricing";
import { describe, expect, it } from "vitest";

import {
  createPaymentTerminalService,
  parsePaymentReference,
  parsePaymentFailedEnvelope,
  parseProviderReference,
  parsePaymentSucceededEnvelope,
  PaymentTerminalError,
  type PaymentTerminalFact,
  type PaymentTerminalObservation,
  type PaymentTerminalPorts,
} from "../index.js";

const ids = {
  observation: "00000000-0000-7000-8000-000000000001",
  receipt: "00000000-0000-7000-8000-000000000002",
  account: "00000000-0000-7000-8000-000000000003",
  intent: "00000000-0000-7000-8000-000000000004",
  attempt: "00000000-0000-7000-8000-000000000005",
  brand: "00000000-0000-7000-8000-000000000006",
  store: "00000000-0000-7000-8000-000000000007",
  operation: "00000000-0000-7000-8000-000000000008",
  order: "00000000-0000-7000-8000-000000000009",
  transaction: "00000000-0000-7000-8000-00000000000a",
  event: "00000000-0000-7000-8000-00000000000b",
  audit: "00000000-0000-7000-8000-00000000000c",
} as const;
const occurredAt = "2026-08-03T18:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

function observation(
  overrides: Partial<PaymentTerminalObservation> = {},
): PaymentTerminalObservation {
  return {
    observationReference: ids.observation,
    webhookReceiptReference: ids.receipt,
    providerEventReference: "evt_synthetic123",
    providerAccountReference: ids.account,
    providerIntentReference: "pi_synthetic123",
    environment: "Test",
    paymentIntentReference: ids.intent,
    paymentAttemptReference: ids.attempt,
    brandReference: ids.brand,
    storeReference: ids.store,
    source: "VerifiedWebhook",
    status: "Captured",
    amount: createMoney({ amountMinor: 1250n, currencyCode: parseCurrencyCode("CAD") }),
    failureReason: null,
    retryDisposition: null,
    occurredAt,
    evidenceDigest: digest,
    ...overrides,
  } as PaymentTerminalObservation;
}

function fixture(
  options: {
    mode?: "created" | "existing" | "conflict";
    mismatch?: boolean;
    sourceFailure?: boolean;
  } = {},
) {
  let committed: PaymentTerminalFact | null = null;
  const commits: {
    fact: PaymentTerminalFact;
    event: PaymentTerminalFact["event"];
  }[] = [];
  const ports: PaymentTerminalPorts = {
    clock: { now: () => occurredAt },
    references: {
      generate: (purpose) => (purpose === "PaymentTransaction" ? ids.transaction : ids.event),
    },
    source: {
      resolve: async () => {
        if (options.sourceFailure) throw new Error("raw provider dependency message");
        return {
          paymentIntentReference: parsePaymentReference(ids.intent),
          paymentAttemptReference: parsePaymentReference(ids.attempt),
          paymentOperationReference: parsePaymentReference(ids.operation),
          orderReference: parsePaymentReference(ids.order),
          brandReference: parsePaymentReference(ids.brand),
          storeReference: parsePaymentReference(options.mismatch ? ids.brand : ids.store),
          provider: "Stripe",
          environment: "Test",
          providerAccountReference: parsePaymentReference(ids.account),
          providerIntentReference: parseProviderReference("pi_synthetic123"),
          expectedAmount: createMoney({
            amountMinor: 1250n,
            currencyCode: parseCurrencyCode("CAD"),
          }),
        };
      },
    },
    audit: {
      create: async ({ fact, correlationReference }) => ({
        auditId: ids.audit,
        brandId: fact.brandReference,
        storeId: fact.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_TERMINAL_RECORDED",
        targetType: "PaymentIntent",
        targetId: fact.paymentIntentReference,
        afterSummary: { outcome: fact.outcome },
        reasonCode: fact.outcome === "Succeeded" ? "PAYMENT_CAPTURED" : "PAYMENT_FAILED",
        correlationId: correlationReference,
        occurredAt: fact.recordedAt,
        sourceChannel: "PROVIDER_WEBHOOK",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    },
    repository: {
      commit: async (input) => {
        commits.push(input);
        if (options.mode === "conflict") return { status: "Conflict", fact: input.fact };
        if (options.mode === "existing" && committed !== null)
          return { status: "AlreadyCommitted", fact: committed };
        committed = input.fact;
        return { status: "Created", fact: input.fact };
      },
    },
  };
  return { service: createPaymentTerminalService(ports), commits };
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentTerminalError);
    return (error as PaymentTerminalError).code;
  }
  throw new Error("expected PaymentTerminalError");
}

describe("WP-1305 Payment terminal facts and Events", () => {
  it("atomically composes one minimal PaymentSucceeded fact and stable event", async () => {
    const { service, commits } = fixture();
    const result = await service.record(observation());
    expect(result.status).toBe("Created");
    expect(commits).toHaveLength(1);
    const event = parsePaymentSucceededEnvelope(result.fact.event);
    expect(event).toMatchObject({
      eventType: "PaymentSucceeded",
      tenantId: ids.brand,
      storeId: ids.store,
      aggregateId: ids.intent,
      causationId: ids.receipt,
      correlationId: ids.operation,
      redactionClassification: "payment",
      payload: {
        amountMinor: "1250",
        currencyCode: "CAD",
        evidenceKind: "Captured",
        orderReference: ids.order,
      },
    });
    expect(JSON.stringify(event.payload)).not.toMatch(
      /provider|receipt|account|evt_|digest|raw|secret/iu,
    );
    expect(Object.isFrozen(result.fact)).toBe(true);
  });

  it("publishes a bounded PaymentFailed event without Provider detail", async () => {
    const { service } = fixture();
    const result = await service.record(
      observation({
        status: "Failed",
        amount: null,
        failureReason: "Declined",
        retryDisposition: "NewOperation",
      }),
    );
    const event = parsePaymentFailedEnvelope(result.fact.event);
    expect(event.payload).toMatchObject({
      reason: "Declined",
      retryDisposition: "NewOperation",
      orderReference: ids.order,
    });
    expect(event.payload).not.toHaveProperty("amountMinor");
  });

  it("rejects non-terminal Provider states before any dependency", async () => {
    const { service, commits } = fixture();
    expect(await code(service.record({ ...observation(), status: "Pending" }))).toBe(
      "PAYMENT_TERMINAL_STATE_NOT_TERMINAL",
    );
    expect(commits).toHaveLength(0);
  });

  it("fails closed on amount or exact scope mismatch", async () => {
    expect(
      await code(
        fixture().service.record(
          observation({
            amount: createMoney({
              amountMinor: 1249n,
              currencyCode: parseCurrencyCode("CAD"),
            }),
          }),
        ),
      ),
    ).toBe("PAYMENT_TERMINAL_AMOUNT_MISMATCH");
    expect(await code(fixture({ mismatch: true }).service.record(observation()))).toBe(
      "PAYMENT_TERMINAL_SCOPE_MISMATCH",
    );
  });

  it("returns an identical committed replay and rejects a conflicting terminal outcome", async () => {
    const replay = fixture({ mode: "existing" });
    const first = await replay.service.record(observation());
    const second = await replay.service.record(observation());
    expect(first.status).toBe("Created");
    expect(second.status).toBe("AlreadyCommitted");
    expect(second.fact).toBe(first.fact);
    expect(await code(fixture({ mode: "conflict" }).service.record(observation()))).toBe(
      "PAYMENT_TERMINAL_OUTCOME_CONFLICT",
    );
  });

  it("rejects malformed public event additions and never echoes sensitive values", () => {
    const unsafe = { token: "sk_synthetic_secret" };
    expect(() => parsePaymentSucceededEnvelope(unsafe)).toThrow(PaymentTerminalError);
    try {
      parsePaymentSucceededEnvelope(unsafe);
    } catch (error) {
      expect(String(error)).not.toContain("sk_synthetic_secret");
    }
  });

  it("normalizes dependency exceptions without exposing Provider text", async () => {
    const promise = fixture({ sourceFailure: true }).service.record(observation());
    expect(await code(promise)).toBe("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
    await expect(promise).rejects.not.toThrow("raw provider dependency message");
  });
});
