import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ bridge: vi.fn(), query: vi.fn(), read: vi.fn() }));
vi.mock("./merchant-reconciliation-follow-up-transactions.js", () => ({
  createMerchantReconciliationFollowUpTransactions: d.bridge,
}));
vi.mock("@rms/payment", () => ({ createPostgresReconciliationFollowUpQuery: d.query }));
import { createMerchantReconciliationFollowUpQuery } from "./merchant-reconciliation-follow-up-query.js";
type Options = Parameters<typeof createMerchantReconciliationFollowUpQuery>[0];
const id = (n: number) => "0190fa82-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    tx = {},
    allowed = vi.fn(async () => true);
  const auth = vi.fn(async () => ({ sessionReference: id(5) }));
  d.bridge.mockResolvedValue({
    scope,
    transactions: { run: async (work: (t: object) => Promise<unknown>) => work(tx) },
    resolveAuthority: async () => ({ authorize: allowed }),
  });
  d.query.mockReturnValue(d.read);
  d.read.mockResolvedValue({
    version: 1,
    followUpStatus: "Open",
    assigned: false,
    acknowledged: false,
    updatedAt: "2026-09-21T00:00:00.000Z",
  });
  return {
    scope,
    tx,
    auth,
    allowed,
    query: createMerchantReconciliationFollowUpQuery({
      persistence: {} as Options["persistence"],
      authentication: { authorize: auth } as unknown as Options["authentication"],
    }),
    input: { sessionCookie: "synthetic", csrf: "synthetic", query: { exceptionReference: id(6) } },
  };
}
it("authenticates then reads owner facts without constructing a command", async () => {
  const f = fixture();
  expect(await f.query(f.input)).toMatchObject({ version: 1, followUpStatus: "Open" });
  expect(f.auth).toHaveBeenCalledWith(f.input);
  expect(d.read).toHaveBeenCalledWith(f.tx, id(6));
  const opts = d.query.mock.calls[0]?.[0];
  expect(
    await opts.authorize(
      f.tx,
      { ...f.scope, exceptionReference: id(6) },
      "ReadPaymentReconciliationFollowUp",
    ),
  ).toBe(true);
  expect(
    await opts.authorize(
      f.tx,
      { ...f.scope, exceptionReference: id(99) },
      "ReadPaymentReconciliationFollowUp",
    ),
  ).toBe(false);
  f.allowed.mockResolvedValue(false);
  expect(
    await opts.authorize(
      f.tx,
      { ...f.scope, exceptionReference: id(6) },
      "ReadPaymentReconciliationFollowUp",
    ),
  ).toBe(false);
});
it("rejects client scope or failed authentication before owner reads", async () => {
  const f = fixture();
  await expect(
    f.query({ ...f.input, query: { ...f.input.query, storeReference: id(9) } }),
  ).rejects.toThrow();
  expect(d.read).not.toHaveBeenCalled();
  f.auth.mockRejectedValue(new Error("DENIED"));
  await expect(f.query(f.input)).rejects.toThrow("DENIED");
  expect(d.read).not.toHaveBeenCalled();
});
