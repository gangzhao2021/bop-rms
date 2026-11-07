import { expect, it, vi } from "vitest";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { createDiningBatchCancellationSource } from "./dining-batch-cancellation-source.js";
const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  history: vi.fn(),
  clock: vi.fn(),
  progress: vi.fn(),
  windowStart: vi.fn(),
}));
vi.mock("@rms/payment", () => ({
  createPostgresPaymentOperationFence: () => ({ acquire: mocks.fence }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderBatchCheckoutExpiryStore: () => ({ load: mocks.history }),
  loadDiningBatchPaymentWindowStart: (...args: unknown[]) => mocks.windowStart(...args),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: () => ({ loadSubmission: mocks.clock }),
}));
vi.mock("./dining-order-delivery-progress.js", () => ({
  createDiningOrderDeliveryProgress: () => ({ load: mocks.progress }),
}));
async function fixture() {
  const at = "2026-09-11T10:00:00.000Z",
    f = orderSubmissionFixture(at),
    record = (await f.orderService().create(f.orderInput)).record;
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
  const scope = {
    tenantReference: id(976),
    brandReference: clock.brandReference,
    storeReference: clock.storeReference,
  };
  const expiry = {
    ...scope,
    orderReference: clock.orderReference,
    orderBatchReference: clock.orderBatchReference,
    submissionReference: clock.submissionReference,
    commitmentReference: clock.commitmentReference,
    paymentOperationReference: clock.paymentOperationReference,
    recordReference: id(977),
    previousRecordReference: null,
    version: 1,
    paymentRequestedAt: at,
    capacityExpiresAt: clock.capacityExpiresAt,
    observedAt: "2026-09-11T10:31:00.000Z",
    evidenceDigest: "sha256:" + "a".repeat(64),
    status: "PaymentFailed",
    paymentEvidence: {
      paymentIntentReference: id(978),
      paymentAttemptReference: id(979),
      paymentEventReference: id(980),
      outcome: "Failed",
      occurredAt: at,
    },
  };
  const progress = {
    ...scope,
    orderReference: clock.orderReference,
    orderVersion: 2,
    orderCheckpoint: id(981),
    kitchenEvidenceComplete: true,
    items: [
      {
        orderItemReference: id(982),
        orderBatchReference: clock.orderBatchReference,
        phase: "Submitted",
        everAccepted: false,
        everStarted: false,
      },
    ],
  };
  const tx = { query: vi.fn() },
    authorize = vi.fn(async () => true);
  mocks.fence.mockReset().mockResolvedValue(undefined);
  mocks.history.mockReset().mockImplementation(async () => {
    expect(mocks.fence).toHaveBeenCalledTimes(1);
    return [expiry];
  });
  mocks.clock.mockReset().mockResolvedValue(clock);
  mocks.progress.mockReset().mockResolvedValue(progress);
  const source = createDiningBatchCancellationSource({
    scope,
    now: () => expiry.observedAt,
    authorize,
    authorizeKitchen: async () => true,
    authorizeDining: async () => true,
  });
  mocks.windowStart.mockReset().mockResolvedValue(at);
  return { source, expiry, progress, clock, prepared, tx, authorize };
}
it("binds latest expiry, real owner clock and current progress in the same transaction", async () => {
  const f = await fixture(),
    result = await f.source.load(f.tx, f.expiry);
  expect(result.checkpoint).toBe(f.progress.orderCheckpoint);
  expect(result.items).toEqual(f.progress.items);
  expect(mocks.history.mock.calls[0]?.[0]).toBe(f.tx);
  expect(mocks.progress.mock.calls[0]?.[0].transaction).toBe(f.tx);
});
it.each(["history", "clock", "progress", "authority"])(
  "refuses unavailable or mismatched %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "history") mocks.history.mockResolvedValue([]);
    if (kind === "clock")
      mocks.clock.mockResolvedValue({ ...f.clock, orderBatchReference: id(999) });
    if (kind === "progress")
      mocks.progress.mockResolvedValue({ ...f.progress, kitchenEvidenceComplete: false });
    if (kind === "authority") f.authorize.mockResolvedValue(false);
    await expect(f.source.load(f.tx, f.expiry)).rejects.toThrow(
      "DINING_BATCH_CANCELLATION_SOURCE_UNAVAILABLE",
    );
  },
);
it("WP-2423 item 5: loads an unresolved round only under the fence and as the latest evidence", async () => {
  const f = await fixture();
  await expect(
    f.source.load(f.tx, {
      ...f.expiry,
      status: "AwaitingPaymentResolution",
      paymentEvidence: null,
    }),
  ).rejects.toThrow("DINING_BATCH_CANCELLATION_SOURCE_UNAVAILABLE");
  // The fence is taken, then the evidence differs from the latest recorded (failed) one.
  expect(mocks.fence).toHaveBeenCalledTimes(1);
});

it("WP-2423 item 3: accepts a never-requested round's expiry stated from Ordering's window start", async () => {
  const f = await fixture();
  const unresolved = { ...f.expiry, status: "AwaitingPaymentResolution", paymentEvidence: null };
  mocks.history.mockResolvedValue([unresolved]);
  mocks.clock.mockResolvedValue(f.prepared);
  expect(f.prepared.paymentRequestedAt).toBeNull();
  expect(String(f.prepared.preparationValidUntil) <= unresolved.observedAt).toBe(true);
  const result = await f.source.load(f.tx, unresolved);
  expect(result.expiry).toEqual(unresolved);
  expect(mocks.windowStart.mock.calls[0]?.[0]).toBe(f.tx);
  expect(mocks.windowStart.mock.calls[0]?.[2]).toEqual({
    orderReference: f.clock.orderReference,
    orderBatchReference: f.clock.orderBatchReference,
    submissionReference: f.clock.submissionReference,
    commitmentReference: f.clock.commitmentReference,
    paymentOperationReference: f.clock.paymentOperationReference,
  });
});
it.each(["window", "missing", "failed", "preparation"])(
  "WP-2423 item 3: refuses a never-requested round's expiry with a mismatched %s",
  async (kind) => {
    const f = await fixture();
    const unresolved = { ...f.expiry, status: "AwaitingPaymentResolution", paymentEvidence: null };
    const subject = kind === "failed" ? f.expiry : unresolved;
    mocks.history.mockResolvedValue([subject]);
    mocks.clock.mockResolvedValue(
      kind === "preparation"
        ? { ...f.prepared, preparationValidUntil: "2026-09-11T10:31:00.001Z" }
        : f.prepared,
    );
    if (kind === "window") mocks.windowStart.mockResolvedValue("2026-09-11T10:00:00.001Z");
    if (kind === "missing") mocks.windowStart.mockResolvedValue(null);
    await expect(f.source.load(f.tx, subject)).rejects.toThrow(
      "DINING_BATCH_CANCELLATION_SOURCE_UNAVAILABLE",
    );
    expect(mocks.progress).not.toHaveBeenCalled();
  },
);
