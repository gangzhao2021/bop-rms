import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const mocks = vi.hoisted(() => ({ refund: vi.fn(), action: vi.fn(), terminal: vi.fn() }));
vi.mock("../application/payment-compensation-refund-codec.js", () => ({
  decodePaymentCompensationRefund: mocks.refund,
}));
vi.mock("../application/payment-compensation-action-codec.js", () => ({
  decodePaymentCompensationAction: mocks.action,
}));
vi.mock("../infrastructure/persistence/payment-terminal-store.js", () => ({
  createPostgresPaymentTerminalStore: () => ({ read: mocks.terminal }),
}));
import { createPostgresConfirmedCompensationRefundSource } from "../infrastructure/persistence/payment-compensation-refund-source.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-22T00:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const input = { observedAt: at, afterRefundReference: null, limit: 10 };
function fixture() {
  const fact = {
    brandReference: id(1),
    storeReference: id(2),
    refundReference: id(3),
    compensationCaseReference: id(4),
    paymentTransactionReference: id(5),
    paymentAttemptReference: id(6),
    paymentIntentReference: id(7),
    orderReference: id(8),
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor: 1130n, currencyCode: "CAD" },
    recordedAt: at,
    providerConfirmedAt: at,
  };
  const action = {
    ...fact,
    actionReference: id(10),
    claimedAt: "2026-09-21T00:00:00.000Z",
    phase: "ProviderConfirmed",
    terminalEvidenceDigest: digest,
    providerIdempotencyKey: "compensation-refund:" + id(10),
  };
  mocks.refund.mockReset().mockReturnValue({ fact, event: {} });
  mocks.action.mockReset().mockReturnValue(action);
  const terminal = {
    ...fact,
    outcome: "Succeeded",
    evidenceDigest: digest,
    recordedAt: "2026-09-20T00:00:00.000Z",
    providerIntentReference: "pi_SYNTHETIC1234",
  };
  mocks.terminal.mockReset().mockResolvedValue(terminal);
  const rows: Record<string, unknown>[] = [{ reference: id(3), record: "refund" }];
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_payment.payment_compensation_refund")
      ? rows
      : sql.includes("FROM rms_payment.payment_compensation_action_history")
        ? [{ record: "action" }]
        : [],
    rowCount: 0,
  }));
  const tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  return {
    fact,
    action,
    terminal,
    rows,
    tx,
    query,
    authorize,
    read: createPostgresConfirmedCompensationRefundSource({
      scope: {
        brandReference: id(1),
        storeReference: id(2),
        providerAccountReference: id(9),
        environment: "Test",
      },
      authorize,
    }),
  };
}
it("recovers the original request without Provider invocation", async () => {
  const f = fixture();
  const page = await f.read(f.tx, input);
  expect(page.records[0]?.request).toMatchObject({
    idempotencyKey: f.action.providerIdempotencyKey,
    providerIntentReference: f.terminal.providerIntentReference,
    amount: f.fact.amount,
  });
  expect(page.nextAfterRefundReference).toBeNull();
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each(["phase", "amount", "case", "terminal", "time"])(
  "rejects invalid binding %s",
  async (kind) => {
    const f = fixture();
    if (kind === "phase") f.action.phase = "Claimed";
    if (kind === "amount") f.action.amount = { amountMinor: 1000n, currencyCode: "CAD" };
    if (kind === "case") f.action.compensationCaseReference = id(99);
    if (kind === "terminal") f.terminal.evidenceDigest = "sha256:" + "b".repeat(64);
    if (kind === "time") f.fact.recordedAt = "2026-09-23T00:00:00.000Z";
    await expect(f.read(f.tx, input)).rejects.toThrow();
  },
);
it("rejects repeated refund identities and cursor violations", async () => {
  const f = fixture();
  f.rows.push({ ...f.rows[0] });
  await expect(f.read(f.tx, input)).rejects.toThrow();
  f.rows.pop();
  await expect(f.read(f.tx, { ...input, afterRefundReference: id(3) })).rejects.toThrow();
});
it("returns an empty source but rejects lost current authority", async () => {
  const f = fixture();
  f.rows.length = 0;
  expect((await f.read(f.tx, input)).records).toEqual([]);
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.tx, input)).rejects.toThrow();
});
