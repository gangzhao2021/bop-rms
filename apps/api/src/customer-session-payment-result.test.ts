import { expect, it, vi } from "vitest";
import {
  createPaymentIntentCreationService,
  parsePaymentReference,
  createPaymentTerminalEnvelope,
} from "@rms/payment";
import { parseCheckoutSession, CheckoutSessionServiceError } from "@rms/ordering";
import { createCustomerSessionPaymentResult } from "./customer-session-payment-result.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import {
  at,
  id,
  refs,
  harness,
  command,
  preparation,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read: mocks.read }),
}));
async function fixture(
  returned?: (orderBatchReference: string) => Promise<boolean>,
  cancelledBy?: (paymentOperationReference: string) => Promise<"Staff" | "Guest" | "System" | null>,
) {
  const original = await createPaymentIntentCreationService(
    harness({ prepared: preparation({ committedAt: at }) }).ports,
  ).create(command({ tipSelectionReference: id(30) }));
  const binding = {
    brandReference: refs.brand,
    storeReference: refs.store,
    cartReference: refs.cart,
    cartVersion: 3,
    quoteReference: refs.quote,
    orderType: "Pickup",
    sourceChannel: "Qr",
  };
  const session = parseCheckoutSession({
    schemaVersion: 1,
    checkoutSessionReference: id(31),
    createOperationReference: id(32),
    submissionReference: refs.submission,
    paymentOperationReference: refs.operation,
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(33),
      validationIntentHash: "sha256:" + "a".repeat(64),
      guestSessionReference: refs.session,
      quoteVersion: 1,
      quoteInputDigest: "sha256:" + "b".repeat(64),
      catalogLines: [
        {
          cartItemReference: id(34),
          sellableReference: id(35),
          menuVersionReference: id(36),
          productVersionReference: id(37),
          validatedAt: at,
        },
      ],
      fulfillment: {
        ...binding,
        status: "Accepted",
        evidenceReference: refs.capacity,
        evidenceVersion: 1,
        evidenceDigest: "sha256:" + "c".repeat(64),
        checkedAt: at,
        validUntil: "2026-08-03T15:05:00.000Z",
      },
      validatedAt: at,
      validUntil: "2026-08-03T15:05:00.000Z",
    },
  });
  mocks.read.mockReset().mockResolvedValue(session);

  const history = { resolveOperation: vi.fn(async () => original.record) };
  const terminal = { read: vi.fn() };
  terminal.read.mockResolvedValue(null);
  let now = at;
  const service = createCustomerSessionPaymentResult({
    access: { now: () => now } as CustomerCheckoutSessionAuthorizationOptions,
    history,
    terminal,
    ...(returned === undefined ? {} : { returned }),
    ...(cancelledBy === undefined ? {} : { cancelledBy }),
  });
  const p = original.record.intent.preparation;
  const fact = {
    paymentTransactionReference: id(80),
    paymentIntentReference: original.record.intent.paymentIntentReference,
    paymentAttemptReference: original.record.attempt.paymentAttemptReference,
    orderReference: p.orderReference,
    brandReference: p.brandReference,
    storeReference: p.storeReference,
    causationReference: id(81),
    webhookReceiptReference: null,
    providerEventReference: null,
    providerAccountReference: id(82),
    providerIntentReference:
      original.record.providerOutcome?.kind === "Snapshot"
        ? original.record.providerOutcome.providerIntentReference
        : "pi_SyntheticResult",
    environment: "Test" as const,
    observationReference: id(83),
    source: "ProviderRetrieval" as const,
    outcome: "Succeeded" as const,
    amount: p.total,
    failureReason: null,
    retryDisposition: null,
    occurredAt: at,
    recordedAt: at,
    evidenceDigest: ("sha256:" + "a".repeat(64)) as never,
  };
  const success = {
    ...fact,
    event: createPaymentTerminalEnvelope({
      eventReference: id(84),
      correlationReference: refs.operation,
      fact: fact as never,
    }),
  };
  return {
    service,
    history,
    terminal,
    session,
    original,
    success,
    setTime(value: string) {
      now = value;
    },
    input: {
      sessionCredential: "s".repeat(43),
      csrfCredential: "c".repeat(43),
      checkoutSessionReference: session.checkoutSessionReference,
    },
  };
}
it("waits for committed terminal evidence even when a Provider snapshot exists", async () => {
  const f = await fixture();
  expect(await f.service.read(f.input)).toMatchObject({
    status: "Pending",
    paymentIntentReference: f.original.record.intent.paymentIntentReference,
  });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  f.terminal.read.mockResolvedValue(f.success);
  const result = await f.service.read(f.input);
  expect(result.status).toBe("Succeeded");
  expect(Object.keys(result).sort()).toEqual([
    "checkoutSessionReference",
    "failure",
    "orderBatchReference",
    "orderReference",
    "payBy",
    "paymentIntentReference",
    "status",
    "total",
  ]);
  expect(result.failure).toBeNull();
  expect(result.orderBatchReference).toBe(
    String(f.original.record.intent.preparation.orderBatchReference),
  );
  expect(result.payBy).toBe(String(f.original.record.intent.preparation.capacityExpiresAt));
  expect(JSON.stringify(result)).not.toContain("pi_");
});
it("never reads another operation's terminal and reauthorizes before returning", async () => {
  const f = await fixture();
  f.history.resolveOperation.mockResolvedValue({
    ...f.original.record,
    intent: {
      ...f.original.record.intent,
      paymentOperationReference: parsePaymentReference(id(90)),
    },
  });
  await expect(f.service.read(f.input)).rejects.toThrow();
  expect(f.terminal.read).not.toHaveBeenCalled();
  f.history.resolveOperation.mockResolvedValue(f.original.record);
  f.terminal.read.mockResolvedValue(f.success);
  mocks.read
    .mockReset()
    .mockResolvedValueOnce(f.session)
    .mockRejectedValueOnce(new CheckoutSessionServiceError("PERMISSION_DENIED"));
  await expect(f.service.read(f.input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
});
it("rejects forged terminal scope, amount and time instead of publishing success", async () => {
  for (const kind of ["scope", "amount", "future", "clock"]) {
    const f = await fixture();
    if (kind === "scope")
      f.terminal.read.mockResolvedValue({ ...f.success, storeReference: id(90) });
    if (kind === "amount")
      f.terminal.read.mockResolvedValue({
        ...f.success,
        amount: { ...f.success.amount, amountMinor: 1n },
      });
    if (kind === "future")
      f.terminal.read.mockResolvedValue({ ...f.success, recordedAt: "2099-01-01T00:00:00.000Z" });
    if (kind === "clock")
      f.terminal.read.mockImplementation(async () => {
        f.setTime("2020-01-01T00:00:00.000Z");
        return null;
      });
    await expect(f.service.read(f.input)).rejects.toThrow();
  }
});
it("reports a committed failure without implying successful payment", async () => {
  const f = await fixture();
  const fact = {
    ...f.success,
    outcome: "Failed" as const,
    amount: null,
    failureReason: "ProviderRejected" as const,
    retryDisposition: "Never" as const,
  };
  f.terminal.read.mockResolvedValue({
    ...fact,
    event: createPaymentTerminalEnvelope({
      eventReference: id(85),
      correlationReference: refs.operation,
      fact: fact as never,
    }),
  });
  expect(await f.service.read(f.input)).toMatchObject({ status: "Failed", failure: "Declined" });
  // WP-2423 abandoned payment: an attempt cancelled because it was never finished.
  const cancelled = { ...fact, failureReason: "Cancelled" as const };
  f.terminal.read.mockResolvedValue({
    ...cancelled,
    event: createPaymentTerminalEnvelope({
      eventReference: id(86),
      correlationReference: refs.operation,
      fact: cancelled as never,
    }),
  });
  expect(await f.service.read(f.input)).toMatchObject({
    status: "Failed",
    failure: "NotCompleted",
  });
});

it("v15 batch-5: a cancelled attempt whose round its payer stopped is said as stopped, never as timed out", async () => {
  const asked: string[] = [];
  for (const [answer, failure] of [
    [async () => true, "StoppedByGuest"],
    [async () => false, "NotCompleted"],
    // Ordering can't be read: said as before, never an outage.
    [
      async () => {
        throw new Error("synthetic outage");
      },
      "NotCompleted",
    ],
  ] as const) {
    const f = await fixture(async (batch) => {
      asked.push(batch);
      return answer();
    });
    const cancelled = {
      ...f.success,
      outcome: "Failed" as const,
      amount: null,
      failureReason: "Cancelled" as const,
      retryDisposition: "Never" as const,
    };
    f.terminal.read.mockResolvedValue({
      ...cancelled,
      event: createPaymentTerminalEnvelope({
        eventReference: id(87),
        correlationReference: refs.operation,
        fact: cancelled as never,
      }),
    });
    expect(await f.service.read(f.input)).toMatchObject({ status: "Failed", failure });
  }
  expect(asked).toHaveLength(3);
  expect(new Set(asked).size).toBe(1);
});

// v15 b15 (order 12, L14 OSC B): staff cancelled an unpaid round while its guest was on the payment
// page; the payment was cancelled with it and the page said it "wasn't finished in time".
it("a cancelled attempt whose round staff cancelled is said as cancelled by the restaurant", async () => {
  const asked: string[] = [];
  for (const [answer, failure] of [
    [async () => "Staff" as const, "CancelledByStaff"],
    [async () => "System" as const, "NotCompleted"],
    [async () => null, "NotCompleted"],
    // Ordering can't be read: said as before, never an outage.
    [
      async () => {
        throw new Error("synthetic outage");
      },
      "NotCompleted",
    ],
  ] as const) {
    const f = await fixture(undefined, async (operation) => {
      asked.push(operation);
      return answer();
    });
    const cancelled = {
      ...f.success,
      outcome: "Failed" as const,
      amount: null,
      failureReason: "Cancelled" as const,
      retryDisposition: "Never" as const,
    };
    f.terminal.read.mockResolvedValue({
      ...cancelled,
      event: createPaymentTerminalEnvelope({
        eventReference: id(88),
        correlationReference: refs.operation,
        fact: cancelled as never,
      }),
    });
    expect(await f.service.read(f.input)).toMatchObject({ status: "Failed", failure });
  }
  expect(asked).toEqual(Array(4).fill(refs.operation));
});

// v15 b15 review (L14 OSC A round 3): the System cancelled the round 2 minutes before the guest
// looked, but Payment had not recorded the cancelled attempt yet, so the page still offered
// "Finish paying · $5.09". Ordering's cancellation (recorded only once Payment proved nothing was
// charged) now answers while Payment has no outcome: with a payment, and with none at all.
it("a round cancelled before Payment recorded an outcome, or before any payment, is said as cancelled", async () => {
  for (const [answer, status, failure] of [
    [async () => "Staff" as const, "Failed", "CancelledByStaff"],
    [async () => "System" as const, "Failed", "NotCompleted"],
    [async () => "Guest" as const, "Failed", "StoppedByGuest"],
    [async () => null, "Pending", null],
    // Ordering can't be read: said as before (still open), never an outage.
    [
      async () => {
        throw new Error("synthetic outage");
      },
      "Pending",
      null,
    ],
  ] as const) {
    const asked: string[] = [];
    const f = await fixture(undefined, async (operation) => {
      asked.push(operation);
      return answer();
    });
    expect(await f.service.read(f.input)).toMatchObject({
      paymentIntentReference: String(f.original.record.intent.paymentIntentReference),
      status,
      failure,
    });
    // No payment was ever started for this checkout (System: PAYMENT_NOT_STARTED).
    f.history.resolveOperation.mockResolvedValue(null as never);
    expect(await f.service.read(f.input)).toEqual({
      checkoutSessionReference: f.session.checkoutSessionReference,
      paymentIntentReference: null,
      orderReference: null,
      orderBatchReference: null,
      status,
      total: null,
      payBy: null,
      failure,
    });
    expect(asked).toEqual([refs.operation, refs.operation]);
  }
});
