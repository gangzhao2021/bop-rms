import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ scope: vi.fn(), source: vi.fn(), store: vi.fn(), resolve: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("@rms/payment", () => ({
  createPostgresPaymentCompensationReconciliationSource: () => d.source,
  createPostgresPaymentCompensationOperationsStore: d.store,
}));
import { createMerchantCompensationReconciliationQuery } from "./merchant-compensation-reconciliation-query.js";
type Options = Parameters<typeof createMerchantCompensationReconciliationQuery>[0];
const id = (n: number) => "0190fa83-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function fixture() {
  const state = { allowed: true };
  d.scope.mockImplementation(async () => ({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed: async () => state.allowed,
  }));
  const authenticate = vi.fn(async () => ({ sessionReference: id(5) }));
  const query = createMerchantCompensationReconciliationQuery({
    persistence: {
      transactions: { run: async (work: (tx: object) => Promise<unknown>) => work({}) },
    } as unknown as Options["persistence"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
  });
  return {
    state,
    authenticate,
    query,
    input: {
      sessionCookie: "synthetic-cookie",
      csrf: "synthetic-csrf",
      query: { orderReference: id(6), caseReference: id(7) },
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.source.mockResolvedValue({
    caseRecord: { orderReference: id(6), version: 2, state: "Open" },
    refund: {
      refundReference: id(8),
      evidenceDigest: digest,
      providerConfirmedAt: at,
      amount: { amountMinor: 1130n, currencyCode: "CAD" },
    },
  });
  d.resolve.mockResolvedValue(null);
  d.store.mockReturnValue({ resolve: d.resolve });
});
it("returns current confirmed facts without payment IDs or evidence and uses operator permission", async () => {
  const f = fixture();
  expect(await f.query(f.input)).toEqual({
    caseVersion: 2,
    caseState: "Open",
    refund: { amountMinor: "1130", currencyCode: "CAD", confirmedAt: at },
    acknowledgmentRecorded: false,
  });
  expect(f.authenticate).toHaveBeenCalledWith(f.input);
  expect(d.scope.mock.calls.every((c) => c[2] === "operations.order-exception.manage")).toBe(true);
});
it("reports persisted acknowledgment before Case projection closes", async () => {
  const f = fixture();
  d.resolve.mockResolvedValue({ refundReference: id(8), refundEvidenceDigest: digest });
  expect(await f.query(f.input)).toMatchObject({ caseState: "Open", acknowledgmentRecorded: true });
  d.resolve.mockResolvedValue({ refundReference: id(99), refundEvidenceDigest: digest });
  await expect(f.query(f.input)).rejects.toThrow("UNAVAILABLE");
});
it("never substitutes zero for missing or wrong-order evidence", async () => {
  const f = fixture();
  d.source.mockResolvedValueOnce(null);
  await expect(f.query(f.input)).rejects.toThrow("UNAVAILABLE");
  d.source.mockResolvedValueOnce({ caseRecord: { orderReference: id(99) } });
  await expect(f.query(f.input)).rejects.toThrow("UNAVAILABLE");
  expect(d.resolve).not.toHaveBeenCalled();
});
it("denies invalid input and current permission loss", async () => {
  const f = fixture();
  await expect(
    f.query({ ...f.input, query: { ...f.input.query, actorReference: id(99) } }),
  ).rejects.toThrow();
  f.state.allowed = false;
  await expect(f.query(f.input)).rejects.toThrow();
  expect(d.source).not.toHaveBeenCalled();
});
