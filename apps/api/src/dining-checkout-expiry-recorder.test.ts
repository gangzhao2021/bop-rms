import { expect, it, vi } from "vitest";
import { createDiningCheckoutExpiryRecorder } from "./dining-checkout-expiry-recorder.js";
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  observe: vi.fn(),
  load: vi.fn(),
  append: vi.fn(),
  store: vi.fn(),
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresPaymentOperationFence: () => ({ acquire: mocks.acquire }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderBatchCheckoutExpiryStore: (options: unknown) => mocks.store(options),
}));
vi.mock("./dining-checkout-timeout-observation.js", () => ({
  createDiningCheckoutTimeoutObservation: () => ({ resolve: mocks.observe }),
}));
const id = (n: number) => `0190ee30-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture() {
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    providerAccountReference: id(4),
    environment: "Test" as const,
  };
  const input = {
    orderReference: id(5),
    orderBatchReference: id(6),
    allocation: {
      brandReference: id(2),
      storeReference: id(3),
      guestSessionReference: id(7),
      cartReference: id(8),
      cartVersion: 1,
      quoteReference: id(9),
      quoteVersion: 1,
      createOperationReference: id(10),
      checkoutSessionReference: id(11),
      submissionReference: id(12),
      paymentOperationReference: id(13),
      allocatedAt: "2026-09-21T00:00:00.000Z",
    },
  };
  const observation = {
    orderReference: id(5),
    orderBatchReference: id(6),
    submissionReference: id(12),
    paymentOperationReference: id(13),
    commitmentReference: id(14),
    paymentRequestedAt: "2026-09-21T00:00:00.000Z",
    capacityExpiresAt: "2026-09-21T00:30:00.000Z",
    observedAt: "2026-09-21T00:31:00.000Z",
    status: "Unresolved",
    reason: "TerminalUnavailable",
  };
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  let sequence = 20;
  const authorize = vi.fn(async () => true);
  mocks.acquire.mockReset().mockResolvedValue({ paymentIntentReference: id(15) });
  mocks.observe.mockReset().mockImplementation(async () => {
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    return observation;
  });
  mocks.load.mockReset().mockResolvedValue([]);
  mocks.append.mockReset().mockImplementation(async (transaction, record) => {
    expect(transaction).toBe(tx);
    return { status: "Created", record };
  });
  mocks.store.mockReset().mockImplementation(() => ({ load: mocks.load, append: mocks.append }));
  const recorder = createDiningCheckoutExpiryRecorder({
    scope,
    transactions: { run: (work) => work(tx) },
    authorize,
    now: () => observation.observedAt,
    newReference: () => id(sequence++),
  });
  const paid = {
    ...observation,
    status: "PaidBeforeDeadline",
    paymentIntentReference: id(15),
    paymentAttemptReference: id(16),
    paymentEventReference: id(17),
    terminalOccurredAt: "2026-09-21T00:10:00.000Z",
  };
  return { input, tx, recorder, authorize, observation, paid };
}
it("holds the same transaction through fence, observation and unresolved append", async () => {
  const f = fixture();
  const result = await f.recorder.record(f.input);
  expect(result).toMatchObject({
    status: "Created",
    record: { status: "AwaitingPaymentResolution", paymentEvidence: null, version: 1 },
  });
  expect(mocks.acquire.mock.calls[0]?.[0]).toBe(f.tx);
  expect(mocks.observe.mock.calls[0]?.[0]).toBe(f.tx);
});
it("returns existing unchanged uncertainty without duplicate append", async () => {
  const f = fixture();
  const first = await f.recorder.record(f.input);
  if (!("record" in first)) throw new Error("record missing");
  mocks.load.mockResolvedValue([first.record]);
  mocks.append.mockClear();
  mocks.acquire.mockClear();
  expect(await f.recorder.record(f.input)).toEqual({ status: "Existing", record: first.record });
  expect(mocks.append).not.toHaveBeenCalled();
});
it("appends terminal evidence as version two without restarting the clock", async () => {
  const f = fixture();
  const first = await f.recorder.record(f.input);
  if (!("record" in first)) throw new Error("record missing");
  mocks.load.mockResolvedValue([first.record]);
  mocks.observe.mockResolvedValue(f.paid);
  expect(await f.recorder.record(f.input)).toMatchObject({
    status: "Created",
    record: {
      version: 2,
      previousRecordReference: first.record.recordReference,
      paymentRequestedAt: first.record.paymentRequestedAt,
      capacityExpiresAt: first.record.capacityExpiresAt,
      status: "PaidBeforeDeadline",
      paymentEvidence: { paymentEventReference: id(17) },
    },
  });
});
it("does not replace a terminal record with a conflicting observation", async () => {
  const f = fixture();
  mocks.observe.mockResolvedValue(f.paid);
  const first = await f.recorder.record(f.input);
  if (!("record" in first)) throw new Error("record missing");
  mocks.load.mockResolvedValue([first.record]);
  mocks.observe.mockResolvedValue(f.observation);
  mocks.append.mockClear();
  await expect(f.recorder.record(f.input)).rejects.toThrow(
    "DINING_CHECKOUT_EXPIRY_RECORDING_UNAVAILABLE",
  );
  expect(mocks.append).not.toHaveBeenCalled();
});
it("does not write NotDue or another batch's observation", async () => {
  const f = fixture();
  mocks.observe.mockResolvedValue({ ...f.observation, status: "NotDue" });
  expect(await f.recorder.record(f.input)).toEqual({ status: "NotDue" });
  expect(mocks.store).not.toHaveBeenCalled();
  mocks.observe.mockResolvedValue({ ...f.observation, orderBatchReference: id(90) });
  await expect(f.recorder.record(f.input)).rejects.toThrow();
  expect(mocks.store).not.toHaveBeenCalled();
});
it("fails before payment locks when current authorization is denied", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.recorder.record(f.input)).rejects.toThrow();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.observe).not.toHaveBeenCalled();
});

it("does not manufacture timeout evidence for a payment clock that never started", async () => {
  const f = fixture();
  mocks.observe.mockResolvedValue({ ...f.observation, status: "NotStarted" });
  expect(await f.recorder.record(f.input)).toEqual({ status: "NotStarted" });
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
});
