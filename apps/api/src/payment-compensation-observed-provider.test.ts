import { beforeEach, expect, it, vi } from "vitest";
import {
  parseProviderIdempotencyKey,
  parsePaymentReference,
  parseProviderReference,
  parsePaymentProviderOutcome,
} from "@rms/payment";
import { createMoney, parseCurrencyCode } from "@rms/pricing";
import type { ConsumerTransaction } from "@bop/eventing";
const d = vi.hoisted(() => ({ record: vi.fn(), factory: vi.fn() }));
vi.mock("@rms/payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/payment")>()),
  createPostgresPaymentProviderObservationStore: d.factory,
}));
import { createPaymentCompensationObservedProvider } from "./payment-compensation-observed-provider.js";
const id = (n: number) =>
  parsePaymentReference("0190fa73-0000-7000-8000-" + String(n).padStart(12, "0"));
const context = {
  provider: "Stripe" as const,
  environment: "Test" as const,
  brandReference: id(1),
  storeReference: id(2),
  paymentAttemptReference: id(3),
  operationReference: id(4),
};
const money = (n: bigint) =>
  createMoney({ amountMinor: n, currencyCode: parseCurrencyCode("CAD") });
const snapshot = parsePaymentProviderOutcome({
  kind: "Snapshot" as const,
  context,
  providerIntentReference: parseProviderReference("pi_DEMOtest"),
  providerTransactionReference: "ch_DEMOtest",
  paymentMethod: "OnlineCard" as const,
  captureMode: "Automatic" as const,
  status: "Captured" as const,
  requestedAmount: money(1130n),
  authorizedAmount: money(1130n),
  capturedAmount: money(1130n),
  refundedAmount: money(1130n),
  observedAt: "2026-09-21T00:00:00.000Z",
  evidenceDigest: "sha256:" + "a".repeat(64),
});
if (snapshot.kind !== "Snapshot") throw new Error("Expected Snapshot fixture");
const request = {
  operation: "RetrieveIntent" as const,
  purpose: "RetrievePaymentIntent" as const,
  context,
  providerIntentReference: parseProviderReference("pi_DEMOtest"),
};
beforeEach(() => {
  vi.resetAllMocks();
  d.record.mockResolvedValue({ status: "Recorded", observationReference: id(6) });
  d.factory.mockReturnValue({ record: d.record });
});
function fixture() {
  const tx = { query: vi.fn() } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true),
    provider = {
      retrieveIntent: vi.fn(async () => snapshot),
      refundPayment: vi.fn(async () => snapshot),
    };
  const options = {
    transactions: { run: async <T>(work: (t: ConsumerTransaction) => Promise<T>) => work(tx) },
    context,
    paymentIntentReference: id(5),
    providerIntentReference: parseProviderReference("pi_DEMOtest"),
    provider,
    authorize,
    now: () => "2026-09-21T00:00:01.000Z",
    newObservationReference: () => id(6),
  };
  return { adapter: createPaymentCompensationObservedProvider(options), provider, authorize, tx };
}
it("records a bound Snapshot in the caller transaction before returning", async () => {
  const f = fixture();
  expect(await f.adapter.retrieveIntent(request)).toEqual(snapshot);
  expect(d.record).toHaveBeenCalledWith({
    observationReference: id(6),
    paymentIntentReference: id(5),
    snapshot,
  });
  expect(f.provider.retrieveIntent.mock.invocationCallOrder[0]).toBeLessThan(
    Number(d.record.mock.invocationCallOrder[0]),
  );
  expect(await d.factory.mock.calls[0]?.[0].run((tx: unknown) => tx)).toBe(f.tx);
  expect(f.authorize).toHaveBeenCalledTimes(3);
});
it("does not report success if observation persistence fails", async () => {
  const f = fixture();
  d.record.mockRejectedValue(new Error("write failed"));
  await expect(
    f.adapter.refundPayment({
      operation: "RefundPayment",
      purpose: "RefundPayment",
      context,
      idempotencyKey: parseProviderIdempotencyKey("compensation-refund:" + id(4)),
      providerIntentReference: parseProviderReference("pi_DEMOtest"),
      originalPaymentMethod: "OnlineCard",
      amount: money(1130n),
    }),
  ).rejects.toThrow("write failed");
  expect(f.provider.refundPayment).toHaveBeenCalledTimes(1);
});
it("rejects mismatched request before Provider and mismatched response before storage", async () => {
  const f = fixture();
  await expect(
    f.adapter.retrieveIntent({ ...request, context: { ...context, operationReference: id(90) } }),
  ).rejects.toThrow();
  expect(f.provider.retrieveIntent).not.toHaveBeenCalled();
  f.provider.retrieveIntent.mockResolvedValue({
    ...snapshot,
    providerIntentReference: parseProviderReference("pi_OTHER"),
  });
  await expect(f.adapter.retrieveIntent(request)).rejects.toThrow();
  expect(d.record).not.toHaveBeenCalled();
});
it.each([0, 1, 2])("rejects revocation at authorization step %s", async (allowed) => {
  const f = fixture();
  let calls = 0;
  f.authorize.mockImplementation(async () => calls++ < allowed);
  await expect(f.adapter.retrieveIntent(request)).rejects.toThrow();
  if (allowed === 0) expect(f.provider.retrieveIntent).not.toHaveBeenCalled();
  if (allowed < 2) expect(d.record).not.toHaveBeenCalled();
});
