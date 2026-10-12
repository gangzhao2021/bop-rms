import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  submitted: vi.fn(),
  deadline: vi.fn(),
  payment: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  loadCheckoutAllocationSubmittedBatch: m.submitted,
  loadCheckoutSessionDeadline: m.deadline,
}));
vi.mock("./checkout-allocation-payment-observation.js", () => ({
  createCheckoutAllocationPaymentObservation: () => ({ resolve: m.payment }),
}));
import { createCheckoutAllocationReplacementObservation } from "./dining-cart-replacement-settlement.js";

const id = (n: number) => "0190ee41-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-11T23:00:00.000Z";
const allocation = {
  brandReference: id(1),
  storeReference: id(2),
  guestSessionReference: id(3),
  createOperationReference: id(4),
  cartReference: id(5),
  cartVersion: 3,
  quoteReference: id(6),
  quoteVersion: 2 as const,
  checkoutSessionReference: id(7),
  submissionReference: id(8),
  paymentOperationReference: id(9),
  allocatedAt: "2026-10-11T22:00:00.000Z",
};
const authorize = vi.fn(async () => true);
const observation = createCheckoutAllocationReplacementObservation({
  scope: {
    brandReference: id(1),
    storeReference: id(2),
    providerAccountReference: id(10),
    environment: "Test",
  },
  now: () => at,
  authorize,
});
const tx = { query: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockResolvedValue(true);
  m.submitted.mockResolvedValue(false);
  m.deadline.mockResolvedValue("2026-10-11T22:30:00.000Z");
  m.payment.mockResolvedValue({ status: "Unresolved", reason: "IntentUnavailable" });
});
it("WP-2423: a submitted order batch settles the checkout whatever its payment state", async () => {
  m.submitted.mockResolvedValue(true);
  expect(await observation.resolve(tx, allocation)).toEqual({
    status: "Settled",
    reason: "OrderSubmitted",
  });
  expect(m.submitted).toHaveBeenCalledWith(tx, allocation);
  expect(m.payment).not.toHaveBeenCalled();
});
it("WP-2423: a terminal failed payment settles it; a success whose order is not processed waits", async () => {
  m.payment.mockResolvedValue({ status: "Terminal", outcome: "Failed" });
  expect(await observation.resolve(tx, allocation)).toEqual({
    status: "Settled",
    reason: "PaymentFailed",
  });
  m.payment.mockResolvedValue({ status: "Terminal", outcome: "Succeeded" });
  expect(await observation.resolve(tx, allocation)).toEqual({
    status: "Pending",
    reason: "AwaitingOrderProcessing",
  });
});
it("WP-2423: a payment without terminal outcome is in flight and waits", async () => {
  m.payment.mockResolvedValue({ status: "Unresolved", reason: "TerminalUnavailable" });
  expect(await observation.resolve(tx, allocation)).toEqual({
    status: "Pending",
    reason: "PaymentInFlight",
  });
  expect(m.deadline).not.toHaveBeenCalled();
});
it("WP-2423: an intent-less checkout settles only after its checkout session deadline", async () => {
  expect(await observation.resolve(tx, allocation)).toEqual({
    status: "Settled",
    reason: "CheckoutExpired",
  });
  expect(m.deadline).toHaveBeenCalledWith(tx, allocation);
  m.deadline.mockResolvedValue("2026-10-11T23:10:00.000Z");
  expect(await observation.resolve(tx, allocation)).toEqual({
    status: "Pending",
    reason: "CheckoutOpen",
  });
  // Exactly at the deadline it can no longer be used.
  m.deadline.mockResolvedValue(at);
  expect((await observation.resolve(tx, allocation)).status).toBe("Settled");
  // No session record is not proof of expiry.
  m.deadline.mockResolvedValue(null);
  expect((await observation.resolve(tx, allocation)).status).toBe("Pending");
});
it("WP-2423: refuses foreign scope, lost authority and owner failures rather than settling", async () => {
  await expect(
    observation.resolve(tx, { ...allocation, storeReference: id(99) }),
  ).rejects.toThrow();
  authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(observation.resolve(tx, allocation)).rejects.toThrow();
  m.submitted.mockRejectedValue(new Error("private"));
  await expect(observation.resolve(tx, allocation)).rejects.toThrow();
  m.submitted.mockResolvedValue(false);
  m.payment.mockRejectedValue(new Error("private"));
  await expect(observation.resolve(tx, allocation)).rejects.toThrow();
});
