import { it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ payment: vi.fn(), order: vi.fn() }));
vi.mock("./checkout-allocation-payment-observation.js", () => ({
  createCheckoutAllocationPaymentObservation: () => ({ resolve: mocks.payment }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresOrderPaymentDispositionReader: () => ({ loadByPaymentEvent: mocks.order }),
}));
import { createCheckoutAllocationOrderObservation } from "./checkout-allocation-order-observation.js";
const id = (n: number) => "0190ed95-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-20T12:00:00.000Z",
  earlier = "2026-09-20T11:00:00.000Z";
const preparation = () => ({
  brandReference: id(1),
  storeReference: id(2),
  orderReference: id(3),
  orderBatchReference: id(4),
  submissionReference: id(5),
});
const payment = () => ({
  status: "Terminal",
  outcome: "Succeeded",
  payment: { intent: { preparation: preparation() } },
  terminal: {
    paymentIntentReference: id(6),
    paymentAttemptReference: id(7),
    paymentTransactionReference: id(8),
    event: { eventId: id(9) },
  },
});
const effect = () => ({
  record: {
    ...preparation(),
    paymentIntentReference: id(6),
    paymentAttemptReference: id(7),
    paymentTransactionReference: id(8),
    paymentEventReference: id(9),
    evaluatedAt: earlier,
    disposition: "Confirmed",
    confirmedAt: earlier,
  },
  orderConfirmedEvent: {},
});
const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
function fixture() {
  const authorize = vi.fn(async () => true);
  return {
    authorize,
    source: createCheckoutAllocationOrderObservation({
      scope: {
        brandReference: id(1),
        storeReference: id(2),
        providerAccountReference: id(10),
        environment: "Test",
      },
      now: () => at,
      authorize,
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.payment.mockResolvedValue(payment());
  mocks.order.mockResolvedValue(effect());
});
it("matches immutable Order processing to exact payment and batch without SQL or new locks", async () => {
  const f = fixture();
  expect(await f.source.resolve(tx, {})).toMatchObject({ status: "Confirmed" });
  expect(mocks.order).toHaveBeenCalledWith({ transaction: tx, paymentEventReference: id(9) });
  expect(tx.query).not.toHaveBeenCalled();
});
it.each(["IntentUnavailable", "TerminalUnavailable"])("preserves unresolved %s", async (reason) => {
  mocks.payment.mockResolvedValue({ status: "Unresolved", reason });
  expect(await fixture().source.resolve(tx, {})).toEqual({ status: "Unresolved", reason });
  expect(mocks.order).not.toHaveBeenCalled();
});
it("does not declare failed Payment resource recovery complete", async () => {
  mocks.payment.mockResolvedValue({ ...payment(), outcome: "Failed" });
  expect(await fixture().source.resolve(tx, {})).toMatchObject({
    status: "Unresolved",
    reason: "FailedPaymentRequiresRecovery",
  });
});
it("keeps unprocessed captured payment unresolved", async () => {
  mocks.order.mockResolvedValue(null);
  expect(await fixture().source.resolve(tx, {})).toMatchObject({
    reason: "AwaitingOrderProcessing",
  });
});
it("keeps compensation required unresolved", async () => {
  const e = effect();
  mocks.order.mockResolvedValue({
    ...e,
    record: { ...e.record, disposition: "PaidWithoutFulfillableOrder" },
    orderConfirmedEvent: null,
  });
  expect(await fixture().source.resolve(tx, {})).toMatchObject({
    reason: "PaymentCompensationRequired",
  });
});
it.each([
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "paymentIntentReference",
  "paymentAttemptReference",
  "paymentTransactionReference",
  "paymentEventReference",
])("rejects mismatched %s", async (field) => {
  const e = effect();
  mocks.order.mockResolvedValue({ ...e, record: { ...e.record, [field]: id(99) } });
  await expect(fixture().source.resolve(tx, {})).rejects.toThrow();
});
it("rejects future confirmation or missing confirmation event", async () => {
  const e = effect();
  for (const changed of [
    { ...e, record: { ...e.record, confirmedAt: "2099-01-01T00:00:00.000Z" } },
    { ...e, orderConfirmedEvent: null },
  ]) {
    mocks.order.mockResolvedValue(changed);
    await expect(fixture().source.resolve(tx, {})).rejects.toThrow();
  }
});
it("rejects revoked authority", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.source.resolve(tx, {})).rejects.toThrow();
});
