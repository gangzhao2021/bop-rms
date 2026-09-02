/// <reference lib="dom" />

import { describe, expect, it } from "vitest";

import { setPaymentOperationReference } from "../../../apps/customer-pwa/src/session/customer-transaction-context.js";
import {
  createPaymentController,
  type CustomerPaymentClient,
} from "../../../apps/customer-pwa/src/payment/payment-controller.js";
import {
  createPaymentTerminalService,
  parsePaymentReference,
  parsePaymentSucceededEnvelope,
  parseProviderReference,
  PaymentTerminalError,
  type PaymentTerminalFact,
  type PaymentTerminalObservation,
  type PaymentTerminalPorts,
} from "../../../packages/rms/payment/src/index.js";
import { createMoney, parseCurrencyCode } from "../../../packages/rms/pricing/src/index.js";

const id = (value: number) => `018f7300-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const at = "2026-08-12T18:00:00.000Z";
const refs = Object.freeze({
  observation: id(1),
  receipt: id(2),
  account: id(3),
  intent: id(4),
  attempt: id(5),
  brand: id(6),
  store: id(7),
  operation: id(8),
  order: id(9),
  transaction: id(10),
  event: id(11),
  audit: id(12),
});

function observation(
  overrides: Partial<PaymentTerminalObservation> = {},
): PaymentTerminalObservation {
  return {
    observationReference: refs.observation,
    causationReference: refs.receipt,
    webhookReceiptReference: refs.receipt,
    providerEventReference: "evt_synthetic123",
    providerAccountReference: refs.account,
    providerIntentReference: "pi_synthetic123",
    environment: "Test",
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    brandReference: refs.brand,
    storeReference: refs.store,
    source: "VerifiedWebhook",
    status: "Captured",
    amount: createMoney({ amountMinor: 1130n, currencyCode: parseCurrencyCode("CAD") }),
    failureReason: null,
    retryDisposition: null,
    occurredAt: at,
    evidenceDigest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  } as PaymentTerminalObservation;
}

function terminalFixture(storeReference = refs.store) {
  let committed: PaymentTerminalFact | null = null;
  let createdFacts = 0;
  const ports: PaymentTerminalPorts = {
    clock: { now: () => at },
    references: {
      generate: (purpose) => (purpose === "PaymentTransaction" ? refs.transaction : refs.event),
    },
    source: {
      resolve: async () => ({
        paymentIntentReference: parsePaymentReference(refs.intent),
        paymentAttemptReference: parsePaymentReference(refs.attempt),
        paymentOperationReference: parsePaymentReference(refs.operation),
        orderReference: parsePaymentReference(refs.order),
        brandReference: parsePaymentReference(refs.brand),
        storeReference: parsePaymentReference(storeReference),
        provider: "Stripe",
        environment: "Test",
        providerAccountReference: parsePaymentReference(refs.account),
        providerIntentReference: parseProviderReference("pi_synthetic123"),
        expectedAmount: createMoney({
          amountMinor: 1130n,
          currencyCode: parseCurrencyCode("CAD"),
        }),
      }),
    },
    audit: {
      create: async ({ fact, correlationReference }) => ({
        auditId: refs.audit,
        brandId: fact.brandReference,
        storeId: fact.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_TERMINAL_RECORDED",
        targetType: "PaymentIntent",
        targetId: fact.paymentIntentReference,
        afterSummary: { outcome: fact.outcome },
        reasonCode: "PAYMENT_CAPTURED",
        correlationId: correlationReference,
        occurredAt: fact.recordedAt,
        sourceChannel: "PROVIDER_WEBHOOK",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    },
    repository: {
      async commit(input) {
        if (committed !== null) return { status: "AlreadyCommitted", fact: committed };
        committed = input.fact;
        createdFacts += 1;
        return { status: "Created", fact: input.fact };
      },
    },
  };
  return { service: createPaymentTerminalService(ports), createdFacts: () => createdFacts };
}

async function errorCode(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentTerminalError);
    return (error as PaymentTerminalError).code;
  }
  throw new Error("expected PaymentTerminalError");
}

describe("WP-2021 Payment Success E2E", () => {
  it("publishes one exact terminal fact and exposes only clean same-operation success", async () => {
    const fixture = terminalFixture();
    const first = await fixture.service.record(observation());
    const replay = await fixture.service.record(observation());
    const event = parsePaymentSucceededEnvelope(first.fact.event);

    expect(first.status).toBe("Created");
    expect(replay.status).toBe("AlreadyCommitted");
    expect(replay.fact).toBe(first.fact);
    expect(fixture.createdFacts()).toBe(1);
    expect(event).toMatchObject({
      eventType: "PaymentSucceeded",
      tenantId: refs.brand,
      storeId: refs.store,
      correlationId: refs.operation,
      payload: {
        orderReference: refs.order,
        amountMinor: "1130",
        currencyCode: "CAD",
        evidenceKind: "Captured",
      },
    });

    setPaymentOperationReference(refs.operation);
    const publicObservation = {
      schemaVersion: 1,
      operationReference: event.correlationId,
      status: "Succeeded",
      orderReference: event.payload.orderReference,
    } as const;
    const client: CustomerPaymentClient = {
      available: () => true,
      create: async () => {
        throw new Error("unused");
      },
      observe: async () => publicObservation,
    };
    const controller = createPaymentController("result", client);
    await controller.load();

    expect(controller.getState()).toEqual({
      status: "succeeded",
      operationReference: refs.operation,
      orderReference: refs.order,
    });
    expect(JSON.stringify(publicObservation)).not.toMatch(
      /provider|account|receipt|event|digest|method|secret|raw/iu,
    );
    setPaymentOperationReference(null);
  });

  it("fails closed on amount or Store ownership mismatch", async () => {
    expect(
      await errorCode(
        terminalFixture().service.record(
          observation({
            amount: createMoney({
              amountMinor: 1129n,
              currencyCode: parseCurrencyCode("CAD"),
            }),
          }),
        ),
      ),
    ).toBe("PAYMENT_TERMINAL_AMOUNT_MISMATCH");
    expect(await errorCode(terminalFixture(id(90)).service.record(observation()))).toBe(
      "PAYMENT_TERMINAL_SCOPE_MISMATCH",
    );
  });
});
