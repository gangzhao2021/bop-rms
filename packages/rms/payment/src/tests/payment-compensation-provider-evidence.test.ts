import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const d = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../infrastructure/persistence/payment-terminal-store.js", () => ({
  createPostgresPaymentTerminalStore: () => ({ read: d.read }),
}));
import { createPostgresPaymentCompensationProviderEvidence } from "../infrastructure/persistence/payment-compensation-provider-evidence.js";
const id = (n: number) => "0190fa74-0000-7000-8000-" + String(n).padStart(12, "0");
const fact = {
  refundReference: id(1),
  eventReference: id(2),
  compensationCaseReference: id(3),
  paymentTransactionReference: id(4),
  paymentIntentReference: id(5),
  paymentAttemptReference: id(6),
  orderReference: id(7),
  brandReference: id(8),
  storeReference: id(9),
  originalPaymentMethod: "OnlineCard",
  amount: { amountMinor: 1130n, currencyCode: "CAD" },
  source: "ProviderRetrieval",
  providerConfirmedAt: "2026-09-21T01:00:00.000Z",
  recordedAt: "2026-09-21T01:00:00.000Z",
  evidenceDigest: "sha256:" + "a".repeat(64),
  causationReference: id(10),
};
const terminal = {
  ...fact,
  outcome: "Succeeded",
  environment: "Test",
  providerAccountReference: id(11),
  providerIntentReference: "pi_DEMOevidence",
  occurredAt: "2026-09-21T00:00:00.000Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  d.read.mockResolvedValue(terminal);
});
function fixture() {
  const query = vi.fn(async () => ({ rows: [{ matched: true }], rowCount: 1 })),
    tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true),
    verify = createPostgresPaymentCompensationProviderEvidence({
      scope: {
        brandReference: id(8),
        storeReference: id(9),
        providerAccountReference: id(11),
        environment: "Test",
      },
      authorize,
    });
  return { tx, query, authorize, verify };
}
it("checks committed exact observation against full successful captured amount", async () => {
  const f = fixture();
  expect(await f.verify(f.tx, fact)).toBe(true);
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("o.captured_minor=$8 AND o.refunded_minor=$8"),
    [
      id(8),
      id(9),
      id(5),
      id(6),
      "pi_DEMOevidence",
      fact.evidenceDigest,
      fact.providerConfirmedAt,
      "1130",
      "Test",
      "OnlineCard",
      id(7),
    ],
  );
});
it.each([
  null,
  { ...terminal, outcome: "Failed" },
  { ...terminal, amount: { amountMinor: 1200n, currencyCode: "CAD" } },
  { ...terminal, providerAccountReference: id(90) },
  { ...terminal, orderReference: id(90) },
])("rejects nonmatching terminal before reading observations", async (value) => {
  const f = fixture();
  d.read.mockResolvedValue(value);
  expect(await f.verify(f.tx, fact)).toBe(false);
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects missing committed observation and revoked authorization", async () => {
  const f = fixture();
  f.query.mockResolvedValueOnce({ rows: [{ matched: false }], rowCount: 1 });
  expect(await f.verify(f.tx, fact)).toBe(false);
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await f.verify(f.tx, fact)).toBe(false);
});
it("denies wrong scope or webhook evidence before reads", async () => {
  const f = fixture();
  expect(await f.verify(f.tx, { ...fact, storeReference: id(90) })).toBe(false);
  expect(await f.verify(f.tx, { ...fact, source: "VerifiedWebhook" })).toBe(false);
  f.authorize.mockResolvedValue(false);
  expect(await f.verify(f.tx, fact)).toBe(false);
  expect(d.read).not.toHaveBeenCalled();
});
