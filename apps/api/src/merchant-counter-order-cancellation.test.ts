import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  scope: vi.fn(),
  link: vi.fn(),
  cancellation: vi.fn(),
  cancel: vi.fn(),
  fence: vi.fn(),
  acquire: vi.fn(),
  cardMachine: vi.fn(),
  lockBatch: vi.fn(),
  capacity: vi.fn(),
  commitment: vi.fn(),
  releaseFactory: vi.fn(),
  release: vi.fn(),
  freePlace: vi.fn(),
  batchOf: vi.fn(),
  loadByBatch: vi.fn(),
  candidates: vi.fn(),
  listByBatches: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  loadCounterOrderCapacityLink: d.link,
  loadCounterOrderBatch: d.batchOf,
  listPaperReentryCandidates: d.candidates,
  createPostgresCounterUnpaidCancellation: d.cancellation,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresPaymentOperationFence: d.fence,
  createPostgresCardMachinePaymentStore: d.cardMachine,
}));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresAsapCapacityStore: d.capacity,
  releaseCancelledAsapCapacity: d.freePlace,
}));
vi.mock("./submission-inventory-release.js", () => ({
  createSubmissionInventoryRelease: d.releaseFactory,
}));
import {
  createMerchantCounterOrderCancellation,
  createMerchantPaperReentryCandidates,
} from "./merchant-counter-order-cancellation.js";

const id = (n: number) => "01909986-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantCounterOrderCancellation>[0];
const at = "2026-11-06T12:00:00.000Z";
const record = {
  terminationReference: id(30),
  orderReference: id(5),
  terminatedAt: "2026-11-06T11:58:00.000Z",
  reasonCode: "COUNTER_GUEST_LEFT_UNPAID",
};

function setup() {
  let sequence = 100;
  const tx = { query: vi.fn() };
  const authorize = vi.fn(async () => ({ sessionReference: id(1) }));
  const allowed = vi.fn(async () => true);
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  d.scope.mockResolvedValue({
    actorReference: id(2),
    selected: { tenantReference: id(10) },
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  d.link.mockResolvedValue({
    link: { paymentOperationReference: id(8), submissionReference: id(7) },
    recordedAfterOutage: false,
  });
  d.fence.mockReturnValue({ acquire: d.acquire });
  d.acquire.mockResolvedValue(undefined);
  d.cardMachine.mockReturnValue({
    lockAndLoadByBatch: d.lockBatch,
    loadByBatch: d.loadByBatch,
    listByBatches: d.listByBatches,
  });
  d.batchOf.mockResolvedValue({
    orderBatchReference: id(41),
    recordedAfterOutage: true,
    submittedAt: "2026-11-06T11:50:00.000Z",
    ended: false,
  });
  d.loadByBatch.mockResolvedValue({ orderReference: id(40) });
  d.lockBatch.mockResolvedValue(null);
  d.capacity.mockReturnValue({
    withCurrentSubmission: async (
      _submission: string,
      work: (tx: unknown, current: unknown) => Promise<unknown>,
    ) => work(tx, await d.commitment()),
  });
  d.commitment.mockResolvedValue({
    orderReference: id(5),
    orderBatchReference: id(6),
    state: "PaymentPending",
  });
  d.cancellation.mockReturnValue({ cancel: d.cancel });
  d.cancel.mockResolvedValue({ status: "Cancelled", record });
  d.releaseFactory.mockReturnValue({ release: d.release });
  d.release.mockResolvedValue({ status: "Released", entryCount: 1 });
  d.freePlace.mockResolvedValue("Released");
  const installContext = vi.fn(async () => undefined);
  const operation = createMerchantCounterOrderCancellation({
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    installContext,
    nextReference: () => id(sequence++),
  });
  const input = (command: Record<string, unknown> = {}) => ({
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      operationReference: id(20),
      orderReference: id(5),
      orderBatchReference: id(6),
      expectedOrderVersion: 1,
      reasonCode: "COUNTER_GUEST_LEFT_UNPAID",
      ...command,
    },
  });
  return { operation, input, allowed, installContext, tx };
}

beforeEach(() => vi.clearAllMocks());

it("WP-2423 M127: cancels an unpaid counter order in one transaction and puts its stock back under the staff member's name", async () => {
  const { operation, input, installContext } = setup();
  expect(await operation(input())).toEqual({
    status: "Cancelled",
    cancelledAt: record.terminatedAt,
  });
  expect(installContext).toHaveBeenCalledWith(expect.anything(), {
    tenantReference: id(10),
    brandReference: id(3),
    storeReference: id(4),
  });
  // Payment's fence, then the card-machine batch lock, before the termination.
  expect(d.acquire).toHaveBeenCalledWith(expect.anything(), {
    orderReference: id(5),
    paymentOperationReference: id(8),
  });
  expect(d.lockBatch).toHaveBeenCalledWith(expect.anything(), id(5), id(6));
  expect(d.acquire.mock.invocationCallOrder[0]).toBeLessThan(
    d.lockBatch.mock.invocationCallOrder[0] ?? 0,
  );
  expect(d.lockBatch.mock.invocationCallOrder[0]).toBeLessThan(
    d.cancel.mock.invocationCallOrder[0] ?? 0,
  );
  expect(d.cancel).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      orderReference: id(5),
      orderBatchReference: id(6),
      operationReference: id(20),
      expectedOrderVersion: 1,
      actorReference: id(2),
      reasonCode: "COUNTER_GUEST_LEFT_UNPAID",
      cancelledAt: at,
    }),
  );
  expect(d.releaseFactory).toHaveBeenCalledWith(
    expect.objectContaining({
      systemActorReference: id(2),
      reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
    }),
  );
  expect(d.release).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      source: {
        kind: "CounterUnpaidCancellationInventory/v1",
        reference: id(30),
        submissionReference: id(7),
        orderReference: id(5),
        occurredAt: record.terminatedAt,
      },
      releasedAt: record.terminatedAt,
    }),
  );
  // DEC-CANCELLED-ORDER-FREES-PICKUP-PLACE: its pickup place is freed in the same transaction,
  // after the termination, linked to it.
  expect(d.freePlace).toHaveBeenCalledWith(
    expect.anything(),
    { brandReference: id(3), storeReference: id(4) },
    expect.objectContaining({
      submissionReference: id(7),
      orderReference: id(5),
      orderBatchReference: id(6),
      correlationReference: id(30),
    }),
  );
  expect(d.cancel.mock.invocationCallOrder[0]).toBeLessThan(
    d.freePlace.mock.invocationCallOrder[0] ?? 0,
  );
});

it("WP-2423 M127: a retry of the same cancellation answers AlreadyCancelled and only verifies the earlier release", async () => {
  const { operation, input } = setup();
  d.cancel.mockResolvedValue({ status: "AlreadyCancelled", record });
  expect(await operation(input())).toEqual({
    status: "AlreadyCancelled",
    cancelledAt: record.terminatedAt,
  });
  // The release is asked again with the original source (it verifies, never releases twice).
  expect(d.release).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      source: expect.objectContaining({ reference: id(30) }),
      releasedAt: at,
    }),
  );
});

it("WP-2423 M127: refuses in staff terms and writes nothing", async () => {
  const { operation, input, allowed } = setup();
  for (const command of [
    { reasonCode: "OTHER" },
    { expectedOrderVersion: 0 },
    { expectedOrderVersion: "1" },
    { orderReference: "not-a-reference" },
    { extra: true },
  ])
    await expect(operation(input(command))).rejects.toMatchObject({
      code: "COUNTER_CANCEL_INPUT_INVALID",
    });
  expect(d.scope).not.toHaveBeenCalled();
  allowed.mockResolvedValueOnce(false);
  await expect(operation(input())).rejects.toMatchObject({
    code: "COUNTER_CANCEL_PERMISSION_DENIED",
  });
  d.link.mockResolvedValueOnce(null);
  await expect(operation(input())).rejects.toMatchObject({ code: "COUNTER_CANCEL_NOT_FOUND" });
  // A paper order is a sale that happened during the outage: recorded and paid, never cancelled.
  d.link.mockResolvedValueOnce({
    link: { paymentOperationReference: id(8), submissionReference: id(7) },
    recordedAfterOutage: true,
  });
  await expect(operation(input())).rejects.toMatchObject({ code: "COUNTER_CANCEL_PAPER_ORDER" });
  d.lockBatch.mockResolvedValueOnce({ paymentReference: id(40) });
  await expect(operation(input())).rejects.toMatchObject({ code: "COUNTER_CANCEL_ALREADY_PAID" });
  d.commitment.mockResolvedValueOnce({
    orderReference: id(5),
    orderBatchReference: id(6),
    state: "Consumed",
  });
  await expect(operation(input())).rejects.toMatchObject({ code: "COUNTER_CANCEL_ALREADY_PAID" });
  for (const [reason, code] of [
    ["PaymentRecorded", "COUNTER_CANCEL_ALREADY_PAID"],
    ["PaperOrder", "COUNTER_CANCEL_PAPER_ORDER"],
    ["VersionConflict", "COUNTER_CANCEL_VERSION_CONFLICT"],
    ["NotCounter", "COUNTER_CANCEL_NOT_FOUND"],
    ["Accepted", "COUNTER_CANCEL_NOT_CANCELLABLE"],
    ["Terminated", "COUNTER_CANCEL_NOT_CANCELLABLE"],
  ] as const) {
    d.cancel.mockResolvedValueOnce({ status: "NotEligible", reason });
    await expect(operation(input())).rejects.toMatchObject({ code });
  }
  expect(d.release).not.toHaveBeenCalled();
  d.release.mockResolvedValueOnce({ status: "NotReleasable" });
  await expect(operation(input())).rejects.toMatchObject({
    code: "COUNTER_CANCEL_STOCK_NOT_RELEASABLE",
  });
});

it("WP-2423 M127: an outage or unexpected answer is 'not confirmed', never 'no permission'", async () => {
  const { operation, input } = setup();
  d.acquire.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "57014" }));
  await expect(operation(input())).rejects.toMatchObject({ code: "COUNTER_CANCEL_UNAVAILABLE" });
  d.commitment.mockResolvedValueOnce({
    orderReference: id(9),
    orderBatchReference: id(6),
    state: "PaymentPending",
  });
  await expect(operation(input())).rejects.toMatchObject({ code: "COUNTER_CANCEL_UNAVAILABLE" });
  d.commitment.mockResolvedValueOnce(null);
  await expect(operation(input())).rejects.toMatchObject({ code: "COUNTER_CANCEL_UNAVAILABLE" });
});

it("DEC-PAPER-ORDER-NEVER-RELEASED: a manager closes a paper order past its time as entered again, naming the new paper order whose payment is recorded", async () => {
  const { operation, input } = setup();
  d.link.mockResolvedValue({
    link: { paymentOperationReference: id(8), submissionReference: id(7) },
    recordedAfterOutage: true,
  });
  d.commitment.mockResolvedValue({
    orderReference: id(5),
    orderBatchReference: id(6),
    state: "PaymentPending",
    capacityExpiresAt: "2026-11-06T11:40:00.000Z",
  });
  const reentry = { reasonCode: "COUNTER_PAPER_REENTERED", reenteredOrderReference: id(40) };
  expect(await operation(input(reentry))).toEqual({
    status: "Cancelled",
    cancelledAt: record.terminatedAt,
  });
  // The new order's payment is read from Payment, and the termination names the new order.
  expect(d.loadByBatch).toHaveBeenCalledWith(expect.anything(), id(40), id(41));
  expect(d.cancel).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      reasonCode: "COUNTER_PAPER_REENTERED",
      reenteredOrderReference: id(40),
    }),
  );
  // Without the new order named, a paper order is still never cancelled; with it, a live order
  // is not closed this way.
  await expect(operation(input({ reasonCode: "COUNTER_GUEST_LEFT_UNPAID" }))).rejects.toMatchObject(
    { code: "COUNTER_CANCEL_PAPER_ORDER" },
  );
  await expect(operation(input({ reasonCode: "COUNTER_PAPER_REENTERED" }))).rejects.toMatchObject({
    code: "COUNTER_CANCEL_INPUT_INVALID",
  });
  // The new order has no recorded payment, is not a paper order, or ended: nothing is closed.
  d.loadByBatch.mockResolvedValueOnce(null);
  await expect(operation(input(reentry))).rejects.toMatchObject({
    code: "COUNTER_CANCEL_REENTRY_INVALID",
  });
  d.batchOf.mockResolvedValueOnce({
    orderBatchReference: id(41),
    recordedAfterOutage: false,
    submittedAt: "2026-11-06T11:50:00.000Z",
    ended: false,
  });
  await expect(operation(input(reentry))).rejects.toMatchObject({
    code: "COUNTER_CANCEL_REENTRY_INVALID",
  });
  d.cancel.mockResolvedValueOnce({ status: "NotEligible", reason: "ReentryUsed" });
  await expect(operation(input(reentry))).rejects.toMatchObject({
    code: "COUNTER_CANCEL_REENTRY_USED",
  });
  // v15 batch-8 review: a cheaper new order never closes the paper order's sale.
  d.cancel.mockResolvedValueOnce({ status: "NotEligible", reason: "ReentryAmountLower" });
  await expect(operation(input(reentry))).rejects.toMatchObject({
    code: "COUNTER_CANCEL_REENTRY_AMOUNT_LOWER",
  });
  // While its window is open, its payment is recorded on it instead.
  d.commitment.mockResolvedValueOnce({
    orderReference: id(5),
    orderBatchReference: id(6),
    state: "PaymentPending",
    capacityExpiresAt: "2026-11-06T12:10:00.000Z",
  });
  await expect(operation(input(reentry))).rejects.toMatchObject({
    code: "COUNTER_CANCEL_PAPER_STILL_RECORDABLE",
  });
  d.link.mockResolvedValueOnce({
    link: { paymentOperationReference: id(8), submissionReference: id(7) },
    recordedAfterOutage: false,
  });
  await expect(operation(input(reentry))).rejects.toMatchObject({
    code: "COUNTER_CANCEL_NOT_CANCELLABLE",
  });
});

it("DEC-PAPER-ORDER-NEVER-RELEASED: the link dialog reads the paper order's sale and the paid new paper orders from the server, marking a cheaper one", async () => {
  setup();
  const tx = { query: vi.fn() };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  const allowed = vi.fn(async () => true);
  d.scope.mockResolvedValue({
    actorReference: id(2),
    selected: { tenantReference: id(10) },
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  d.batchOf.mockResolvedValue({
    orderBatchReference: id(6),
    recordedAfterOutage: true,
    submittedAt: "2026-11-06T11:00:00.000Z",
    ended: false,
    orderNumber: "31",
    sale: { amountMinor: 20000n, currencyCode: "CAD" },
  });
  const candidate = (n: number, amountMinor: bigint) => ({
    orderReference: id(n),
    orderBatchReference: id(n + 1),
    orderNumber: String(n),
    submittedAt: "2026-11-06T11:50:00.000Z",
    sale: { amountMinor, currencyCode: "CAD" },
  });
  d.candidates.mockResolvedValue([
    candidate(50, 500n),
    candidate(60, 20000n),
    candidate(70, 20000n),
  ]);
  const paid = (amountMinor: bigint) => ({
    preparation: { total: { amountMinor } },
    roundingMinor: 0n,
  });
  // Order 70 has no recorded payment yet: it is not offered.
  d.listByBatches.mockResolvedValue(
    new Map([
      [id(51), paid(500n)],
      [id(61), paid(23000n)],
    ]),
  );
  const installContext = vi.fn(async () => undefined);
  const read = createMerchantPaperReentryCandidates({
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    installContext,
  });
  expect(await read({ sessionCookie: "synthetic-cookie", orderReference: id(5) })).toEqual({
    paperOrder: { orderNumber: "31", saleMinor: "20000", currencyCode: "CAD" },
    candidates: [
      expect.objectContaining({ orderNumber: "50", saleMinor: "500", coversSale: false }),
      expect.objectContaining({ orderNumber: "60", saleMinor: "20000", coversSale: true }),
    ],
  });
  expect(d.candidates).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ brandReference: id(3), storeReference: id(4) }),
    id(5),
  );
  // Not a paper order: not found. No permission: refused. An outage: unavailable (never "no
  // permission").
  d.batchOf.mockResolvedValueOnce({
    orderBatchReference: id(6),
    recordedAfterOutage: false,
    submittedAt: "2026-11-06T11:00:00.000Z",
    ended: false,
    orderNumber: "31",
    sale: { amountMinor: 20000n, currencyCode: "CAD" },
  });
  await expect(read({ sessionCookie: "c", orderReference: id(5) })).rejects.toMatchObject({
    code: "COUNTER_CANCEL_NOT_FOUND",
  });
  allowed.mockResolvedValueOnce(false);
  await expect(read({ sessionCookie: "c", orderReference: id(5) })).rejects.toMatchObject({
    code: "COUNTER_CANCEL_PERMISSION_DENIED",
  });
  d.candidates.mockRejectedValueOnce(new Error("connection reset"));
  await expect(read({ sessionCookie: "c", orderReference: id(5) })).rejects.toMatchObject({
    code: "COUNTER_CANCEL_UNAVAILABLE",
  });
  await expect(
    read({ sessionCookie: "c", orderReference: "not-a-reference" }),
  ).rejects.toMatchObject({
    code: "COUNTER_CANCEL_INPUT_INVALID",
  });
});
