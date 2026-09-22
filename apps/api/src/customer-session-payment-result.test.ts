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
async function fixture() {
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
    "orderReference",
    "paymentIntentReference",
    "status",
    "total",
  ]);
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
  expect(await f.service.read(f.input)).toMatchObject({ status: "Failed" });
});
