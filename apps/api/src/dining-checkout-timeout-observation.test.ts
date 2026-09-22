import { expect, it, vi } from "vitest";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { createDiningCheckoutTimeoutObservation } from "./dining-checkout-timeout-observation.js";
const mocks = vi.hoisted(() => ({ clock: vi.fn(), payment: vi.fn() }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: () => ({ loadSubmission: mocks.clock }),
}));
vi.mock("./checkout-allocation-payment-observation.js", () => ({
  createCheckoutAllocationPaymentObservation: () => ({ resolve: mocks.payment }),
}));
async function fixture() {
  const at = "2026-09-11T10:00:00.000Z";
  const f = orderSubmissionFixture(at);
  const record = (await f.orderService().create(f.orderInput)).record;
  const prepared = parseDiningCheckoutCommitment(
    await f.options.preparation.submissions.loadSubmission(record.submissionReference),
  );
  const clock = parseDiningCheckoutCommitment({
    ...prepared,
    state: "PaymentPending",
    orderingLinkedAt: at,
    paymentRequestedAt: at,
    capacityExpiresAt: "2026-09-11T10:30:00.000Z",
  });
  const allocation = {
    brandReference: clock.brandReference,
    storeReference: clock.storeReference,
    guestSessionReference: clock.guestSessionReference,
    cartReference: clock.cartReference,
    cartVersion: clock.cartVersion,
    quoteReference: clock.quoteReference,
    quoteVersion: 1,
    createOperationReference: id(970),
    checkoutSessionReference: id(971),
    submissionReference: clock.submissionReference,
    paymentOperationReference: clock.paymentOperationReference,
    allocatedAt: at,
  };
  const payment = {
    status: "Terminal",
    outcome: "Succeeded",
    payment: {
      intent: {
        paymentIntentReference: id(972),
        preparation: {
          orderReference: clock.orderReference,
          orderBatchReference: clock.orderBatchReference,
          capacityAllocationReference: clock.commitmentReference,
          capacityExpiresAt: clock.capacityExpiresAt,
          committedAt: clock.paymentRequestedAt,
        },
      },
      attempt: { paymentAttemptReference: id(973) },
    },
    terminal: { occurredAt: "2026-09-11T10:10:00.000Z", event: { eventId: id(977) } },
  };
  mocks.clock.mockReset().mockResolvedValue(clock);
  mocks.payment.mockReset().mockResolvedValue(payment);
  let time = "2026-09-11T10:31:00.000Z";
  const authorize = vi.fn(async () => true);
  const source = createDiningCheckoutTimeoutObservation({
    scope: {
      tenantReference: id(976),
      brandReference: clock.brandReference,
      storeReference: clock.storeReference,
      providerAccountReference: id(974),
      environment: "Test",
    },
    now: () => time,
    authorize,
  });
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return {
    source,
    tx,
    allocation,
    clock,
    payment,
    authorize,
    setTime: (at: string) => {
      time = at;
    },
  };
}
it("does not inspect Payment or issue writes before deadline", async () => {
  const f = await fixture();
  f.setTime("2026-09-11T10:29:59.999Z");
  expect(await f.source.resolve(f.tx, f.allocation)).toMatchObject({ status: "NotDue" });
  expect(mocks.payment).not.toHaveBeenCalled();
  expect(f.tx.query).not.toHaveBeenCalled();
});
it.each(["IntentUnavailable", "TerminalUnavailable"])(
  "keeps %s unresolved after deadline",
  async (reason) => {
    const f = await fixture();
    mocks.payment.mockResolvedValue({ status: "Unresolved", reason });
    expect(await f.source.resolve(f.tx, f.allocation)).toMatchObject({
      status: "Unresolved",
      reason,
    });
  },
);
it.each([
  { at: "2026-09-11T10:29:59.999Z", status: "PaidBeforeDeadline" },
  { at: "2026-09-11T10:30:00.000Z", status: "PaidAtOrAfterDeadline" },
  { at: "2026-09-11T10:30:00.001Z", status: "PaidAtOrAfterDeadline" },
])("uses original occurrence at $at, not delayed processing time", async ({ at, status }) => {
  const f = await fixture();
  mocks.payment.mockResolvedValue({
    ...f.payment,
    terminal: { ...f.payment.terminal, occurredAt: at },
  });
  expect(await f.source.resolve(f.tx, f.allocation)).toMatchObject({
    status,
    orderBatchReference: f.clock.orderBatchReference,
    terminalOccurredAt: at,
  });
});
it("retains sealed expired clocks and separates terminal failure from missing facts", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue({ ...f.clock, state: "Expired" });
  mocks.payment.mockResolvedValue({ ...f.payment, outcome: "Failed" });
  expect(await f.source.resolve(f.tx, f.allocation)).toMatchObject({ status: "Failed" });
});
it.each(["orderBatchReference", "capacityAllocationReference", "committedAt"])(
  "rejects mismatched Payment preparation %s",
  async (key) => {
    const f = await fixture();
    mocks.payment.mockResolvedValue({
      ...f.payment,
      payment: {
        ...f.payment.payment,
        intent: {
          ...f.payment.payment.intent,
          preparation: {
            ...f.payment.payment.intent.preparation,
            [key]: key === "committedAt" ? "2026-09-11T10:00:01.000Z" : id(975),
          },
        },
      },
    });
    await expect(f.source.resolve(f.tx, f.allocation)).rejects.toThrow(
      "DINING_CHECKOUT_TIMEOUT_OBSERVATION_UNAVAILABLE",
    );
  },
);
it("fails on foreign allocation before reading owners", async () => {
  const f = await fixture();
  await expect(
    f.source.resolve(f.tx, { ...f.allocation, storeReference: id(975) }),
  ).rejects.toThrow();
  expect(mocks.clock).not.toHaveBeenCalled();
  expect(mocks.payment).not.toHaveBeenCalled();
});
it("does not return evidence after authorization is revoked", async () => {
  const f = await fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.source.resolve(f.tx, f.allocation)).rejects.toThrow(
    "DINING_CHECKOUT_TIMEOUT_OBSERVATION_UNAVAILABLE",
  );
});

it.each(["Prepared", "Expired"])(
  "distinguishes valid unsealed %s from a checkout deadline",
  async (state) => {
    const f = await fixture();
    mocks.clock.mockResolvedValue({
      ...f.clock,
      state,
      orderingLinkedAt: null,
      paymentRequestedAt: null,
      capacityExpiresAt: null,
    });
    expect(await f.source.resolve(f.tx, f.allocation)).toMatchObject({
      status: "NotStarted",
      orderBatchReference: f.clock.orderBatchReference,
    });
    expect(mocks.payment).not.toHaveBeenCalled();
  },
);
it("rejects malformed partial clocks rather than skipping a Batch", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue({ ...f.clock, paymentRequestedAt: null });
  await expect(f.source.resolve(f.tx, f.allocation)).rejects.toThrow(
    "DINING_CHECKOUT_TIMEOUT_OBSERVATION_UNAVAILABLE",
  );
  expect(mocks.payment).not.toHaveBeenCalled();
});
