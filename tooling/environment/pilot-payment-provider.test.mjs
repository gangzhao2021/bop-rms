import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInternalSimulatedProvider } from "./pilot-payment-provider.mjs";
const dirs = [],
  providers = [];
const id = (n) => "0190fa71-0000-7000-8000-" + String(n).padStart(12, "0");
afterEach(() => {
  for (const p of providers.splice(0)) p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const dir = mkdtempSync(join(tmpdir(), "bop-refund-simulator-"));
  dirs.push(dir);
  const binding = {
    brandReference: id(1),
    storeReference: id(2),
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  const config = {
    path: join(dir, "provider.sqlite"),
    expectedDatabaseName: "local_test",
    loadProfile: async () => ({ environment: "InternalTest", database: "local_test", binding }),
  };
  const p = await createInternalSimulatedProvider({ provision: true }, config);
  providers.push(p);
  const context = {
    provider: "Stripe",
    environment: "Test",
    brandReference: id(1),
    storeReference: id(2),
    paymentAttemptReference: id(3),
    operationReference: id(4),
  };
  const created = await p.adapter.createIntent({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context,
    idempotencyKey: "create:" + id(4),
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    amount: { amountMinor: 1130n, currencyCode: "CAD" },
  });
  const retrieve = {
    operation: "RetrieveIntent",
    purpose: "RetrievePaymentIntent",
    context,
    providerIntentReference: created.providerIntentReference,
  };
  await p.simulateCapture(retrieve, "SIMULATE_CAPTURE");
  const refund = (prefix, operation, amountMinor) => ({
    operation: "RefundPayment",
    purpose: "RefundPayment",
    context: { ...context, operationReference: id(operation) },
    idempotencyKey: prefix + id(operation),
    providerIntentReference: created.providerIntentReference,
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor, currencyCode: "CAD" },
  });
  return { p, config, refund, retrieve };
}
test("ordinary and compensation share durable balance; restart and exact retry do not refund twice", async () => {
  const f = await fixture();
  const ordinary = f.refund("ordinary-refund:", 5, 130n);
  expect((await f.p.adapter.refundPayment(ordinary)).kind).toBe("RefundObservation");
  const compensation = f.refund("compensation-refund:", 6, 1000n);
  const result = await f.p.adapter.refundPayment(compensation);
  expect(result.kind).toBe("Snapshot");
  expect(result.refundedAmount.amountMinor).toBe(1130n);
  expect(result.context.operationReference).toBe(id(6));
  f.p.close();
  providers.splice(providers.indexOf(f.p), 1);
  const reopened = await createInternalSimulatedProvider({}, f.config);
  providers.push(reopened);
  expect((await reopened.adapter.refundPayment(compensation)).refundedAmount.amountMinor).toBe(
    1130n,
  );
  expect((await reopened.adapter.lookupRefund(ordinary)).amount.amountMinor).toBe(130n);
  await expect(
    reopened.adapter.refundPayment({
      ...compensation,
      amount: { amountMinor: 999n, currencyCode: "CAD" },
    }),
  ).rejects.toThrow("SIMULATION_IDEMPOTENCY_CONFLICT");
  await expect(reopened.adapter.refundPayment(f.refund("ordinary-refund:", 7, 1n))).rejects.toThrow(
    "SIMULATION_REFUND_BALANCE_UNAVAILABLE",
  );
  expect((await reopened.adapter.retrieveIntent(f.retrieve)).refundedAmount.amountMinor).toBe(
    1130n,
  );
});
test("rejects unbound keys, Live and other Store before changing the journal", async () => {
  const f = await fixture(),
    base = f.refund("compensation-refund:", 6, 1130n);
  for (const request of [
    { ...base, idempotencyKey: "compensation-refund:" + id(7) },
    { ...base, idempotencyKey: "unapproved-refund:" + id(6) },
    { ...base, context: { ...base.context, environment: "Live" } },
    { ...base, context: { ...base.context, storeReference: id(8) } },
  ])
    await expect(f.p.adapter.refundPayment(request)).rejects.toThrow();
  expect((await f.p.adapter.retrieveIntent(f.retrieve)).refundedAmount.amountMinor).toBe(0n);
});

test("exposes scoped independent capture/refund window evidence from its persistent journal", async () => {
  const f = await fixture();
  await f.p.adapter.refundPayment(f.refund("ordinary-refund:", 7, 130n));
  const input = {
    brandReference: id(1),
    storeReference: id(2),
    environment: "Test",
    startsAt: "2000-01-01T00:00:00.000Z",
    endsAt: new Date().toISOString(),
  };
  const result = await f.p.readSettlementWindow(input);
  expect(result).toMatchObject({
    source: "InternalTestSimulator",
    capturedAmountMinor: 1130n,
    refundedAmountMinor: 130n,
  });
  await expect(f.p.readSettlementWindow({ ...input, storeReference: id(9) })).rejects.toThrow(
    "SIMULATION_SETTLEMENT_UNAVAILABLE",
  );
});

test("capture journal preserves original bindings and denies changed profile scope", async () => {
  const f = await fixture(),
    input = {
      brandReference: id(1),
      storeReference: id(2),
      environment: "Test",
      observedAt: new Date().toISOString(),
      afterProviderIntentReference: null,
      limit: 5,
    };
  const page = await f.p.readCaptureJournal(input);
  expect(page.records).toHaveLength(1);
  expect(page.records[0]).toMatchObject({
    providerIntentReference: f.retrieve.providerIntentReference,
    paymentOperationReference: id(4),
    paymentAttemptReference: id(3),
    amount: { amountMinor: 1130n, currencyCode: "CAD" },
  });
  const profile = await f.config.loadProfile();
  profile.binding.storeReference = id(99);
  await expect(f.p.readCaptureJournal(input)).rejects.toThrow();
});
test("WP-2423 abandoned payment: cancels only an unconfirmed intent, which then can't be captured", async () => {
  const f = await fixture();
  const context = {
    ...f.retrieve.context,
    paymentAttemptReference: id(9),
    operationReference: id(10),
  };
  const created = await f.p.adapter.createIntent({
    operation: "CreateIntent",
    purpose: "CreatePaymentIntent",
    context,
    idempotencyKey: "create:" + id(10),
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    amount: { amountMinor: 1689n, currencyCode: "CAD" },
  });
  expect(created.status).toBe("RequiresCustomerAction");
  const retrieve = {
    ...f.retrieve,
    context,
    providerIntentReference: created.providerIntentReference,
  };
  const cancel = {
    operation: "CancelIntent",
    purpose: "CancelPaymentIntent",
    context,
    idempotencyKey: "cancel-abandoned:" + id(9),
    providerIntentReference: created.providerIntentReference,
  };
  const cancelled = await f.p.adapter.cancelIntent(cancel);
  expect(cancelled.status).toBe("Cancelled");
  expect(cancelled.capturedAmount.amountMinor).toBe(0n);
  // Repeating the cancellation answers the same state; capture and decline are refused after it.
  expect((await f.p.adapter.cancelIntent(cancel)).observedAt).toBe(cancelled.observedAt);
  await expect(f.p.simulateCapture(retrieve, "SIMULATE_CAPTURE")).rejects.toThrow();
  await expect(f.p.simulateFailure(retrieve, "SIMULATE_FAILURE")).rejects.toThrow();
  expect(await f.p.readTerminalOccurrence(retrieve)).toEqual({
    status: "Cancelled",
    occurredAt: cancelled.observedAt,
  });
  // A captured intent is never cancelled: the cancellation answers Captured.
  expect(
    (
      await f.p.adapter.cancelIntent({
        ...cancel,
        context: f.retrieve.context,
        providerIntentReference: f.retrieve.providerIntentReference,
      })
    ).status,
  ).toBe("Captured");
});
