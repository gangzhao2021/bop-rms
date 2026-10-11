import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  scope: vi.fn(),
  itemStore: vi.fn(),
  wholeStore: vi.fn(),
  itemReader: vi.fn(),
  load: vi.fn(),
  wholeLoad: vi.fn(),
  loadByCancellation: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  kitchen: vi.fn(),
  cancelItems: vi.fn(),
  refunds: vi.fn(),
  preview: vi.fn(),
  record: vi.fn(),
  followUp: vi.fn(),
  drive: vi.fn(),
  status: vi.fn(),
  remaining: vi.fn(),
  fulfillment: vi.fn(),
  fulfillmentCancel: vi.fn(),
  releaseFactory: vi.fn(),
  releaseLines: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresStaffItemCancellationStore: d.itemStore,
  createPostgresStaffOrderCancellationStore: d.wholeStore,
  createPostgresStaffItemCancellationReader: d.itemReader,
}));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createPostgresKitchenBatchCancellation: d.kitchen,
}));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresFulfillmentItemCancellation: d.fulfillment,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresCancellationRefundRuntime: d.refunds,
  createPostgresCancellationRefundFollowUp: d.followUp,
  readCancellationRefundStatus: d.status,
  readPaymentRemainingRefundable: d.remaining,
}));
vi.mock("./submission-inventory-release.js", () => ({
  createSubmissionInventoryRelease: d.releaseFactory,
}));
import { KitchenBatchCancellationError } from "@rms/kitchen";
import { StaffOrderCancellationError } from "./merchant-order-staff-cancellation.js";
import {
  createItemCancellationRefundAuthority,
  createMerchantOrderItemStaffCancellation,
} from "./merchant-order-item-staff-cancellation.js";

const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrderItemStaffCancellation>[0];
const at = "2026-10-11T12:00:00.000Z";
const digest = "sha256:" + "c".repeat(64);
const plan = (remaining: string[]) => ({
  orderType: "Pickup",
  orderReference: id(5),
  orderBatchReference: id(6),
  submissionReference: id(7),
  expectedOrderVersion: 3,
  expectedSourceCheckpoint: id(8),
  lines: [{ orderItemReference: id(50), sourceCartLineReference: id(60), quantity: 1 }],
  remainingOrderItemReferences: remaining,
  cancelledOrderItemReferences: [],
  payment: {
    dispositionReference: id(9),
    paymentTransactionReference: id(11),
    paymentIntentReference: id(12),
    paymentAttemptReference: id(13),
    paymentEventReference: id(14),
  },
});
const record = {
  cancellationReference: id(100),
  operationReference: id(20),
  orderReference: id(5),
  orderBatchReference: id(6),
  submissionReference: id(7),
  reasonCode: "SOLD_OUT",
  actorReference: id(2),
  expectedOrderVersion: 3,
  orderItemReferences: [id(50)],
  refundRequestReference: id(105),
  refundOperationReference: id(106),
  refundAmountMinor: 565n,
  sourceDigest: digest,
  brandReference: id(3),
  storeReference: id(4),
  cancelledAt: at,
};
function setup(whole = vi.fn()) {
  let sequence = 100;
  const tx = { query: vi.fn() };
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true);
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  d.scope.mockResolvedValue({
    actorReference: id(2),
    selected: { tenantReference: id(10) },
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  d.itemStore.mockReturnValue({ loadByOperation: d.load, prepare: d.prepare, commit: d.commit });
  d.wholeStore.mockReturnValue({ loadByOperation: d.wholeLoad });
  d.itemReader.mockReturnValue({ loadByCancellation: d.loadByCancellation });
  d.load.mockResolvedValue(null);
  d.wholeLoad.mockResolvedValue(null);
  d.prepare.mockResolvedValue({ status: "Ready", plan: plan([id(51)]) });
  d.commit.mockResolvedValue({ status: "Created", record });
  d.kitchen.mockReturnValue({ cancelItems: d.cancelItems });
  d.cancelItems.mockResolvedValue({
    status: "Cancelled",
    kitchenTicketReference: id(40),
    workItemCount: 1,
    evidenceDigest: "sha256:" + "a".repeat(64),
  });
  d.refunds.mockReturnValue({ preview: d.preview, record: d.record });
  d.preview.mockResolvedValue({
    amountMinor: 565n,
    components: {
      netAmountMinor: 500n,
      taxAmountMinor: 65n,
      tipAmountMinor: 0n,
      serviceChargeAmountMinor: 0n,
      serviceChargeTaxAmountMinor: 0n,
    },
    items: [],
  });
  d.record.mockResolvedValue({ status: "Created", amountMinor: 565n });
  d.followUp.mockReturnValue({ drive: d.drive });
  d.drive.mockResolvedValue({ status: "Refunded", amountMinor: 565n });
  d.fulfillment.mockReturnValue({ cancelItems: d.fulfillmentCancel });
  d.fulfillmentCancel.mockResolvedValue({ status: "Recorded" });
  d.releaseFactory.mockReturnValue({ releaseLines: d.releaseLines });
  d.releaseLines.mockResolvedValue({ status: "Released", entryCount: 1 });
  const operation = createMerchantOrderItemStaffCancellation({
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    installContext: vi.fn(async () => undefined),
    nextReference: () => id(sequence++),
    wholeCancellation: whole as unknown as Options["wholeCancellation"],
    resolveRefundConfiguration: async () => ({
      providerAccountReference: id(90),
      environment: "Test",
    }),
    businessDate: async () => "2026-10-11",
    provider: { refundPayment: vi.fn(), lookupRefund: vi.fn() },
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(5),
      orderBatchReference: id(6),
      orderItemReferences: [id(50)],
      expectedOrderVersion: 3,
      operationReference: id(20),
      reasonCode: "SOLD_OUT",
    },
  };
  return { operation, input, allowed, run, tx, whole };
}
beforeEach(() => vi.resetAllMocks());

it("WP-2423 Q6 step 2a: cancels kitchen, Ordering, the item refund claim, fulfillment and stock in one transaction, then dispatches", async () => {
  const f = setup();
  expect(await f.operation.cancel(f.input)).toEqual({
    status: "Cancelled",
    scope: "Items",
    orderReference: id(5),
    orderBatchReference: id(6),
    cancellationReference: id(100),
    orderItemReferences: [id(50)],
    cancelledAt: at,
    refund: { status: "Refunded", amountMinor: "565", currencyCode: "CAD", includesTip: false },
  });
  expect(f.run).toHaveBeenCalledTimes(1);
  const order = [
    d.prepare,
    d.cancelItems,
    d.preview,
    d.commit,
    d.record,
    d.fulfillmentCancel,
    d.releaseLines,
  ].map((fn) => fn.mock.invocationCallOrder[0] as number);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(d.cancelItems.mock.calls[0]?.[1]).toMatchObject({ orderItemReferences: [id(50)] });
  expect(d.commit.mock.calls[0]?.[1]).toMatchObject({
    refundAmountMinor: 565n,
    reasonCode: "SOLD_OUT",
  });
  expect(d.record.mock.calls[0]?.[1]).toMatchObject({
    cancellationReference: id(100),
    cancellationDigest: digest,
    orderItemReferences: [id(50)],
  });
  expect(d.releaseLines.mock.calls[0]?.[1]).toMatchObject({ cartLineReferences: [id(60)] });
  expect(d.drive).toHaveBeenCalledWith({
    orderReference: id(5),
    requestReference: id(105),
    operationReference: id(106),
  });
});

it("keeps the cancellation when dispatch fails after commit (refund pending, never resent here)", async () => {
  const f = setup();
  d.drive.mockRejectedValue(new Error("provider down"));
  expect((await f.operation.cancel(f.input)).refund.status).toBe("Pending");
});

it("refuses started work, legacy stock and stale versions without a partial outcome", async () => {
  const f = setup();
  d.cancelItems.mockRejectedValue(new KitchenBatchCancellationError("KITCHEN_WORK_STARTED"));
  await expect(f.operation.cancel(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_PREPARATION_STARTED",
  });
  expect(d.commit).not.toHaveBeenCalled();
  const g = setup();
  d.releaseLines.mockResolvedValue({ status: "NotReleasable", reason: "LegacyReservation" });
  await expect(g.operation.cancel(g.input)).rejects.toMatchObject({
    code: "ORDER_ITEM_CANCELLATION_STOCK_LEGACY",
  });
  expect(d.drive).not.toHaveBeenCalled();
  const h = setup();
  d.prepare.mockResolvedValue({ status: "NotEligible", reason: "VersionConflict" });
  await expect(h.operation.cancel(h.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_VERSION_CONFLICT",
  });
  const k = setup();
  d.scope.mockRejectedValue(new Error("denied"));
  await expect(k.operation.cancel(k.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_PERMISSION_DENIED",
  });
});

it("replays the same operation without writing, and refuses a different intent under it", async () => {
  const f = setup();
  d.load.mockResolvedValue(record);
  expect((await f.operation.cancel(f.input)).status).toBe("AlreadyCancelled");
  expect(d.prepare).not.toHaveBeenCalled();
  expect(d.cancelItems).not.toHaveBeenCalled();
  await expect(
    f.operation.cancel({ ...f.input, command: { ...f.input.command, reasonCode: "STORE_ERROR" } }),
  ).rejects.toMatchObject({ code: "ORDER_CANCELLATION_NOT_CANCELLABLE" });
});

it("hands the last remaining lines to the whole cancellation (refund incl. tip)", async () => {
  const whole = vi.fn();
  whole.mockResolvedValue({
    status: "Cancelled",
    orderReference: id(5),
    orderBatchReference: id(6),
    cancelledAt: at,
    refundStatus: "Pending",
  });
  const f = setup(whole);
  d.prepare.mockResolvedValue({ status: "Ready", plan: plan([]) });
  d.wholeLoad.mockResolvedValueOnce(null).mockResolvedValue({
    cancellationReference: id(200),
    paymentTransactionReference: id(11),
    paymentIntentReference: id(12),
    paymentAttemptReference: id(13),
  });
  d.remaining.mockResolvedValue({
    capturedMinor: 1380n,
    claimedMinor: 565n,
    remainingMinor: 815n,
    tipMinor: 180n,
    compensationMinor: 0n,
  });
  expect(await f.operation.cancel(f.input)).toMatchObject({
    scope: "Batch",
    cancellationReference: id(200),
    refund: { status: "Pending", amountMinor: "815", includesTip: true },
  });
  expect(d.cancelItems).not.toHaveBeenCalled();
  expect(whole.mock.calls[0]?.[0]).toMatchObject({
    command: { operationReference: id(20), reasonCode: "SOLD_OUT", expectedOrderVersion: 3 },
  });
  whole.mockRejectedValue(
    new StaffOrderCancellationError("ORDER_CANCELLATION_PREPARATION_STARTED"),
  );
  await expect(f.operation.cancel(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_PREPARATION_STARTED",
  });
});

it("previews exactly the items' net and tax, or the remaining payment for the last items", async () => {
  const f = setup();
  const command = {
    orderReference: f.input.command.orderReference,
    orderBatchReference: f.input.command.orderBatchReference,
    orderItemReferences: f.input.command.orderItemReferences,
    expectedOrderVersion: f.input.command.expectedOrderVersion,
  };
  expect(await f.operation.preview({ ...f.input, command })).toEqual({
    scope: "Items",
    refund: {
      amountMinor: "565",
      currencyCode: "CAD",
      includesTip: false,
      netAmountMinor: "500",
      taxAmountMinor: "65",
    },
  });
  expect(d.commit).not.toHaveBeenCalled();
  d.prepare.mockResolvedValue({ status: "Ready", plan: plan([]) });
  d.remaining.mockResolvedValue({
    capturedMinor: 1380n,
    claimedMinor: 0n,
    remainingMinor: 1380n,
    tipMinor: 0n,
    compensationMinor: 0n,
  });
  expect((await f.operation.preview({ ...f.input, command })).refund).toMatchObject({
    amountMinor: "1380",
    includesTip: false,
  });
});

it("binds the refund claim to the Ordering record (request, amount, actor, digest)", async () => {
  d.itemReader.mockReturnValue({ loadByCancellation: d.loadByCancellation });
  d.loadByCancellation.mockResolvedValue(record);
  const port = createItemCancellationRefundAuthority({
    brandReference: id(3),
    storeReference: id(4),
  });
  const query = {
    tenantReference: id(10),
    brandReference: id(3),
    storeReference: id(4),
    orderReference: id(5),
    requestReference: id(105),
    cancellationReference: id(100),
    cancellationDigest: digest,
    actorReference: id(2),
    amountMinor: 565n,
    observedAt: at,
  };
  const tx = { query: vi.fn() };
  expect(await port(tx, query)).toBe(true);
  expect(await port(tx, { ...query, amountMinor: 566n })).toBe(false);
  expect(await port(tx, { ...query, requestReference: id(107) })).toBe(false);
  d.loadByCancellation.mockResolvedValue(null);
  expect(await port(tx, query)).toBe(false);
});
