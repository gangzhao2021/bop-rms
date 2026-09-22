import { beforeEach, afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  owner: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  issuer: vi.fn(),
  issue: vi.fn(),
}));
vi.mock("../../packages/rms/payment/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresPaymentCompensationExceptionSource: m.owner,
}));
vi.mock("../../apps/api/dist/refund-receipt-issuance.js", () => ({
  createRefundReceiptIssuance: m.issuer,
}));
vi.mock("./pilot-receipt-observations.mjs", () => ({
  refreshInternalOrderReceiptObservations: m.refresh,
}));
import { createInternalCompensationReceiptRecovery } from "./pilot-compensation-receipt.mjs";
const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z";
function setup() {
  const scope = {
    brandReference: id(2),
    storeReference: id(3),
    providerAccountReference: id(9),
    environment: "Test",
  };
  const tx = {},
    resources = {
      scope,
      publicProfile: {
        binding: { tenantReference: id(1), validUntil: "2026-09-22T00:00:00.000Z" },
      },
      now: () => at,
      transactions: { run: (work) => work(tx) },
      credentials: { reference: () => id(10) },
    };
  const source = {
    exceptionReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(5),
    paymentIntentReference: id(6),
    paymentAttemptReference: id(7),
    kind: "PaidWithoutFulfillableOrder",
    severity: "Critical",
    state: "Open",
    refundDisposition: "ProviderConfirmed",
    operationsDisposition: "Pending",
    openedAt: at,
    updatedAt: at,
    closedAt: null,
  };
  m.read.mockResolvedValue({ source, sourceVersion: 1, resolutionEvidenceReference: null });
  const disposition = {
    orderReference: id(5),
    paymentIntentReference: id(6),
    paymentAttemptReference: id(7),
  };
  const recover = createInternalCompensationReceiptRecovery({
    resources,
    scope,
    tenantReference: id(1),
    createSimulatedProvider: vi.fn(),
  });
  return { recover, resources, scope, tx, source, disposition };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  m.owner.mockReturnValue(m.read);
  m.refresh.mockResolvedValue(1);
  m.issuer.mockReturnValue(m.issue);
  m.issue.mockResolvedValue({ status: "Existing" });
});
afterEach(() => vi.unstubAllEnvs());
it("refreshes confirmed provider observations then invokes existing tenant-scoped receipt issuance", async () => {
  const f = setup();
  expect(await f.recover(f.disposition, id(4))).toEqual({ status: "Existing" });
  expect(m.refresh.mock.invocationCallOrder[0]).toBeLessThan(m.issue.mock.invocationCallOrder[0]);
  const opts = m.issuer.mock.calls[0][0];
  expect(opts.scope.tenantReference).toBe(id(1));
  expect(await opts.authorize(f.tx, { ...f.scope, orderReference: id(5) })).toBe(true);
  expect(await opts.authorize(f.tx, { ...f.scope, orderReference: id(90) })).toBe(false);
  expect(await opts.authorize({}, { ...f.scope, orderReference: id(5) })).toBe(false);
  expect(m.issue).toHaveBeenCalledWith(f.tx, {
    orderReference: id(5),
    freshAfter: at,
    observedAt: at,
  });
});
it("does not issue a receipt for pending compensation", async () => {
  const f = setup();
  f.source.refundDisposition = "RefundPending";
  expect(await f.recover(f.disposition, id(4))).toEqual({ status: "AwaitingConfirmedRefund" });
  expect(m.refresh).not.toHaveBeenCalled();
  expect(m.issue).not.toHaveBeenCalled();
});
it("rejects another Order or expired installation", async () => {
  const f = setup();
  await expect(f.recover({ ...f.disposition, orderReference: id(90) }, id(4))).rejects.toThrow();
  f.resources.now = () => "2026-09-23T00:00:00.000Z";
  await expect(f.recover(f.disposition, id(4))).rejects.toThrow();
  expect(m.issue).not.toHaveBeenCalled();
});
it("requires refreshed observations and propagates missing-original receipt failure", async () => {
  const f = setup();
  m.refresh.mockResolvedValueOnce(0);
  await expect(f.recover(f.disposition, id(4))).rejects.toThrow();
  expect(m.issue).not.toHaveBeenCalled();
  m.issue.mockRejectedValueOnce(Error("DIGITAL_RECEIPT_CHAIN_CONFLICT"));
  await expect(f.recover(f.disposition, id(4))).rejects.toThrow("DIGITAL_RECEIPT_CHAIN_CONFLICT");
});
it("rechecks current Case before receipt authorization", async () => {
  const f = setup();
  await f.recover(f.disposition, id(4));
  f.source.refundDisposition = "RefundPending";
  expect(
    await m.issuer.mock.calls[0][0].authorize(f.tx, { ...f.scope, orderReference: id(5) }),
  ).toBe(false);
});
