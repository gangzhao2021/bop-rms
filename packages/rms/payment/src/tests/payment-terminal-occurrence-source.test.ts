import { expect, it, vi } from "vitest";
import { createPostgresPaymentTerminalSource } from "../infrastructure/persistence/payment-terminal-source.js";
const id = (n: number) => "01909970-0000-7000-8000-" + String(n).padStart(12, "0");
const scope = {
  brandReference: id(1),
  storeReference: id(2),
  providerAccountReference: id(3),
  environment: "Test",
};
const observation = {
  ...scope,
  observationReference: id(4),
  causationReference: id(5),
  webhookReceiptReference: null,
  providerEventReference: null,
  providerIntentReference: "pi_synthetic123",
  paymentIntentReference: id(6),
  paymentAttemptReference: id(7),
  source: "ProviderRetrieval",
  status: "Captured",
  amount: { amountMinor: 1130n, currencyCode: "CAD" },
  failureReason: null,
  retryDisposition: null,
  occurredAt: "2026-09-21T06:00:00.000Z",
  evidenceDigest: "sha256:" + "a".repeat(64),
};
function fixture() {
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => ({
    rows:
      sql.includes("FROM rms_payment.payment_intent") && values[16] === true
        ? [{ paymentOperationReference: id(8), orderReference: id(9), amountMinor: "1130" }]
        : [],
  }));
  const tx = { query };
  return {
    tx,
    query,
    runner: { run: async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) },
  };
}
it("keeps later observation disabled without explicit verified occurrence", async () => {
  const f = fixture();
  expect(
    await createPostgresPaymentTerminalSource(f.runner, scope).resolve(observation),
  ).toBeNull();
  expect(f.query.mock.calls.at(-1)?.[1][16]).toBe(false);
});
it("passes exact parsed occurrence to configured evidence before and after source lookup", async () => {
  const f = fixture(),
    verifyOccurrence = vi.fn(async () => true);
  const result = await createPostgresPaymentTerminalSource(f.runner, scope, {
    verifyOccurrence,
  }).resolve(observation);
  expect(result?.paymentIntentReference).toBe(id(6));
  expect(verifyOccurrence).toHaveBeenCalledTimes(2);
  expect(verifyOccurrence).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      occurredAt: observation.occurredAt,
      paymentAttemptReference: id(7),
      evidenceDigest: observation.evidenceDigest,
    }),
  );
  expect(f.query.mock.calls.at(-1)?.[1][16]).toBe(true);
});
it("refuses missing or withdrawn occurrence evidence", async () => {
  for (const responses of [[false], [true, false]]) {
    const f = fixture(),
      verifyOccurrence = vi.fn();
    for (const result of responses) verifyOccurrence.mockResolvedValueOnce(result);
    expect(
      await createPostgresPaymentTerminalSource(f.runner, scope, { verifyOccurrence }).resolve(
        observation,
      ),
    ).toBeNull();
  }
});
it("does not use retrieval exception for webhook or foreign scope", async () => {
  const f = fixture(),
    verifyOccurrence = vi.fn(async () => true),
    source = createPostgresPaymentTerminalSource(f.runner, scope, { verifyOccurrence });
  expect(await source.resolve({ ...observation, storeReference: id(99) })).toBeNull();
  expect(
    await source.resolve({
      ...observation,
      source: "VerifiedWebhook",
      webhookReceiptReference: id(5),
      providerEventReference: "evt_synthetic123",
    }),
  ).toBeNull();
  expect(verifyOccurrence).not.toHaveBeenCalled();
});
