import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  scope: vi.fn(),
  ordering: vi.fn(),
  load: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  kitchen: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
  releaseFactory: vi.fn(),
  position: vi.fn(),
  positionFactory: vi.fn(),
  lines: vi.fn(),
  releaseLines: vi.fn(),
  cardMachine: vi.fn(),
  cardMachinePayment: vi.fn(),
  cardMachineRefunds: vi.fn(),
  remaining: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresStaffOrderCancellationStore: d.ordering,
  readStaffBatchLineSources: d.lines,
}));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createPostgresKitchenBatchCancellation: d.kitchen,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresPaymentCompensationRefundPositionSource: d.positionFactory,
  createPostgresCardMachinePaymentStore: d.cardMachine,
  readPaymentRemainingRefundable: d.remaining,
}));
vi.mock("./submission-inventory-release.js", () => ({
  createSubmissionInventoryRelease: d.releaseFactory,
}));
import { KitchenBatchCancellationError } from "@rms/kitchen";
import {
  createMerchantOrderStaffCancellation,
  createMerchantOrderStaffCancellationPreview,
  staffOrderCancellationPermission,
} from "./merchant-order-staff-cancellation.js";

const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrderStaffCancellation>[0];
const at = "2026-10-11T12:00:00.000Z";
const record = {
  cancellationReference: id(30),
  orderReference: id(5),
  orderBatchReference: id(6),
  submissionReference: id(7),
  reasonCode: "SOLD_OUT",
  actorReference: id(2),
  expectedOrderVersion: 3,
  paymentTransactionReference: id(8),
  paymentAttemptReference: id(9),
  cancelledAt: at,
};
function setup() {
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
  d.ordering.mockReturnValue({ loadByOperation: d.load, prepare: d.prepare, commit: d.commit });
  // WP-2423 Q7: an online payment unless a test pays the Batch on the card machine.
  d.cardMachine.mockReturnValue({
    loadByBatch: d.cardMachinePayment,
    refunds: d.cardMachineRefunds,
  });
  d.cardMachinePayment.mockResolvedValue(null);
  d.cardMachineRefunds.mockResolvedValue([]);
  d.load.mockResolvedValue(null);
  d.prepare.mockResolvedValue({
    status: "Ready",
    plan: { synthetic: "plan", orderType: "Pickup" },
  });
  d.commit.mockResolvedValue({ status: "Created", record });
  d.kitchen.mockReturnValue({ cancel: d.cancel });
  d.cancel.mockResolvedValue({
    status: "Cancelled",
    kitchenTicketReference: id(40),
    workItemCount: 2,
    evidenceDigest: "sha256:" + "a".repeat(64),
  });
  d.releaseFactory.mockReturnValue({ release: d.release, releaseLines: d.releaseLines });
  d.lines.mockResolvedValue([
    { orderItemReference: id(50), sourceCartLineReference: id(60), itemCancelled: false },
    { orderItemReference: id(51), sourceCartLineReference: id(61), itemCancelled: false },
  ]);
  d.release.mockResolvedValue({ status: "Released", entryCount: 1 });
  d.positionFactory.mockReturnValue(d.position);
  d.position.mockResolvedValue({ confirmedMinor: 1130n, pendingMinor: 0n });
  const installContext = vi.fn(async () => undefined);
  const operation = createMerchantOrderStaffCancellation({
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    installContext,
    nextReference: () => id(sequence++),
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(5),
      orderBatchReference: id(6),
      expectedOrderVersion: 3,
      operationReference: id(20),
      reasonCode: "SOLD_OUT",
    },
  };
  return { operation, input, allowed, run, tx, installContext };
}
beforeEach(() => vi.resetAllMocks());

it("WP-2423 Q6: cancels kitchen, Ordering and stock in one transaction with server-owned staff and time", async () => {
  const f = setup();
  const ownerAnswers: boolean[] = [];
  d.prepare.mockImplementation(async () => {
    const ownerAuthorize = d.ordering.mock.calls[0]?.[0].authorize;
    const identity = { orderReference: id(5), orderBatchReference: id(6), actorReference: id(2) };
    ownerAnswers.push(await ownerAuthorize(f.tx, identity));
    ownerAnswers.push(await ownerAuthorize(f.tx, { ...identity, orderBatchReference: id(99) }));
    ownerAnswers.push(await ownerAuthorize({}, identity));
    return { status: "Ready", plan: { synthetic: "plan", orderType: "Pickup" } };
  });
  expect(await f.operation(f.input)).toEqual({
    status: "Cancelled",
    orderReference: id(5),
    orderBatchReference: id(6),
    cancelledAt: at,
    refundStatus: "Pending",
    refundMethod: "Online",
    refundAmountMinor: null,
  });
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(d.scope.mock.calls[0]?.[2]).toBe(staffOrderCancellationPermission);
  expect(staffOrderCancellationPermission).toBe("ordering.order.cancel");
  expect(f.installContext).toHaveBeenCalledWith(f.tx, {
    tenantReference: id(10),
    brandReference: id(3),
    storeReference: id(4),
  });
  expect(d.prepare).toHaveBeenCalledWith(f.tx, {
    orderReference: id(5),
    orderBatchReference: id(6),
    expectedOrderVersion: 3,
    actorReference: id(2),
  });
  // Ordering fence first, then kitchen row locks, then the Ordering record, then stock.
  const order = [d.prepare, d.cancel, d.commit, d.release].map(
    (mock) => mock.mock.invocationCallOrder[0] ?? 0,
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const cancellationReference = d.cancel.mock.calls[0]?.[1].orderCancellationReference;
  expect(d.cancel.mock.calls[0]?.[1]).toMatchObject({
    orderReference: id(5),
    orderBatchReference: id(6),
    operationReference: id(20),
    actorReference: id(2),
    cancelledAt: at,
  });
  expect(d.commit.mock.calls[0]?.[1]).toMatchObject({
    plan: { synthetic: "plan", orderType: "Pickup" },
    cancellationReference,
    operationReference: id(20),
    actorReference: id(2),
    reasonCode: "SOLD_OUT",
    kitchenEvidenceDigest: "sha256:" + "a".repeat(64),
    cancelledAt: at,
  });
  expect(d.releaseFactory.mock.calls[0]?.[0]).toMatchObject({
    reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
    systemActorReference: id(2),
  });
  expect(d.release.mock.calls[0]?.[1]).toMatchObject({
    source: {
      kind: "StaffOrderCancellationInventory/v1",
      reference: id(30),
      submissionReference: id(7),
      orderReference: id(5),
      occurredAt: at,
    },
    releasedAt: at,
  });
  // Each owner authorizes only this order, batch and staff member, and only during the run.
  expect(ownerAnswers).toEqual([true, false, false]);
  const identity = { orderReference: id(5), orderBatchReference: id(6), actorReference: id(2) };
  expect(await d.kitchen.mock.calls[0]?.[0].authorize(f.tx, identity)).toBe(false);
  // WP-2423: the caller is resolved in full exactly twice (start, and before the commit).
  expect(d.scope).toHaveBeenCalledTimes(1);
  expect(f.allowed).toHaveBeenCalledTimes(2);
});

it("WP-2423: a permission withdrawn or Session ended during the cancellation cancels nothing", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_PERMISSION_DENIED",
  });
  // The refusal is raised inside the transaction callback after the writes, so they roll back.
  expect(d.commit).toHaveBeenCalledTimes(1);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.allowed).toHaveBeenCalledTimes(2);
});

it("WP-2423 Q6: replays the same staff command without writing and reports the refund", async () => {
  const f = setup();
  d.load.mockResolvedValue(record);
  expect(await f.operation(f.input)).toMatchObject({
    status: "AlreadyCancelled",
    refundStatus: "Refunded",
  });
  expect(d.prepare).not.toHaveBeenCalled();
  expect(d.cancel).not.toHaveBeenCalled();
  expect(d.release).not.toHaveBeenCalled();
  d.position.mockResolvedValue({ confirmedMinor: 0n, pendingMinor: 1130n });
  expect(await f.operation(f.input)).toMatchObject({ refundStatus: "Pending" });
  // The same operation reference for a different intent is refused.
  await expect(
    f.operation({ ...f.input, command: { ...f.input.command, reasonCode: "STORE_ERROR" } }),
  ).rejects.toMatchObject({ code: "ORDER_CANCELLATION_NOT_CANCELLABLE" });
});

it("WP-2423 Q7: a Batch paid on the store's card machine is refunded on that machine", async () => {
  const f = setup();
  d.cardMachinePayment.mockResolvedValue({
    cardMachinePaymentReference: id(8),
    preparation: { total: { amountMinor: 1280n, currencyCode: "CAD" } },
  });
  expect(await f.operation(f.input)).toMatchObject({
    status: "Cancelled",
    refundStatus: "Pending",
    refundMethod: "CardMachine",
    refundAmountMinor: "1280",
  });
  // Never the Provider compensation position for a card-machine payment.
  expect(d.positionFactory).not.toHaveBeenCalled();
  d.load.mockResolvedValue(record);
  d.cardMachineRefunds.mockResolvedValue([
    { sourceKind: "StaffCancellation", sourceReference: id(30), amountMinor: 1280n },
  ]);
  expect(await f.operation(f.input)).toMatchObject({
    status: "AlreadyCancelled",
    refundStatus: "Refunded",
    refundMethod: "CardMachine",
    refundAmountMinor: "1280",
  });
  expect(d.positionFactory).not.toHaveBeenCalled();
});

it("WP-2423 Q6: refuses invalid intent, withdrawn permission and ineligible orders", async () => {
  const f = setup();
  for (const command of [
    { ...f.input.command, reasonCode: "OTHER" },
    { ...f.input.command, expectedOrderVersion: "3" },
    { ...f.input.command, cancelledAt: at },
    { ...f.input.command, orderReference: "not-a-reference" },
  ])
    await expect(f.operation({ ...f.input, command })).rejects.toMatchObject({
      code: "ORDER_CANCELLATION_INPUT_INVALID",
    });
  expect(f.run).not.toHaveBeenCalled();
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_PERMISSION_DENIED",
  });
  f.allowed.mockResolvedValue(true);
  for (const [reason, code] of [
    ["NotFound", "ORDER_CANCELLATION_NOT_FOUND"],
    ["VersionConflict", "ORDER_CANCELLATION_VERSION_CONFLICT"],
    ["NotConfirmed", "ORDER_CANCELLATION_NOT_CANCELLABLE"],
    ["AlreadyCancelled", "ORDER_CANCELLATION_NOT_CANCELLABLE"],
  ] as const) {
    d.prepare.mockResolvedValueOnce({ status: "NotEligible", reason });
    await expect(f.operation(f.input)).rejects.toMatchObject({ code });
  }
  expect(d.cancel).not.toHaveBeenCalled();
});

it("WP-2423 Q6: a started kitchen item or unreleasable stock refuses the whole command", async () => {
  const f = setup();
  d.cancel.mockRejectedValueOnce(new KitchenBatchCancellationError("KITCHEN_WORK_STARTED"));
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_PREPARATION_STARTED",
  });
  expect(d.commit).not.toHaveBeenCalled();
  d.release.mockResolvedValueOnce({ status: "NotReleasable", reason: "ProductionStarted" });
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_STOCK_NOT_RELEASABLE",
  });
  d.cancel.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" }));
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_VERSION_CONFLICT",
  });
  d.commit.mockRejectedValueOnce(new Error("synthetic-private"));
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_UNAVAILABLE",
  });
});

it("WP-2423 Q6 step 2a: after item cancellations the whole cancellation releases only the remaining lines", async () => {
  const f = setup();
  d.lines.mockResolvedValue([
    { orderItemReference: id(50), sourceCartLineReference: id(60), itemCancelled: true },
    { orderItemReference: id(51), sourceCartLineReference: id(61), itemCancelled: false },
  ]);
  d.releaseLines.mockResolvedValue({ status: "Released", entryCount: 1 });
  expect((await f.operation(f.input)).status).toBe("Cancelled");
  expect(d.release).not.toHaveBeenCalled();
  expect(d.releaseLines.mock.calls[0]?.[1]).toMatchObject({ cartLineReferences: [id(61)] });
  d.releaseLines.mockResolvedValue({ status: "NotReleasable", reason: "ProductionStarted" });
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_STOCK_NOT_RELEASABLE",
  });
});

it("WP-2423 v15 2026-10-18: Guests left is refused on a pickup before anything is cancelled", async () => {
  const f = setup();
  const command = { ...f.input.command, reasonCode: "GUEST_LEFT" };
  await expect(f.operation({ ...f.input, command })).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_INPUT_INVALID",
  });
  expect(d.cancel).not.toHaveBeenCalled();
  expect(d.commit).not.toHaveBeenCalled();
  // A table's round may still be cancelled because its guests left.
  d.prepare.mockResolvedValue({
    status: "Ready",
    plan: { synthetic: "plan", orderType: "DineIn" },
  });
  expect((await f.operation({ ...f.input, command })).status).toBe("Cancelled");
  expect(d.commit.mock.calls[0]?.[1]).toMatchObject({ reasonCode: "GUEST_LEFT" });
});

it("WP-2423 v15 2026-10-18: previews what the cancellation refunds without writing", async () => {
  const f = setup();
  const payment = {
    paymentTransactionReference: id(8),
    paymentIntentReference: id(11),
    paymentAttemptReference: id(9),
  };
  d.prepare.mockResolvedValue({
    status: "Ready",
    plan: { orderType: "Pickup", orderReference: id(5), orderBatchReference: id(6), payment },
  });
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(f.tx));
  const preview = createMerchantOrderStaffCancellationPreview({
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    authentication: {
      authorize: async () => ({ sessionReference: id(1) }),
    } as unknown as Options["authentication"],
    installContext: async () => undefined,
    nextReference: () => id(999),
    resolveRefundConfiguration: async () => ({
      providerAccountReference: id(12),
      environment: "Test",
    }),
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: { orderReference: id(5), orderBatchReference: id(6), expectedOrderVersion: 3 },
  };
  // Already refunded in full by an ordinary refund: nothing more.
  d.remaining.mockResolvedValue({ capturedMinor: 1130n, remainingMinor: 0n });
  expect(await preview(input)).toEqual({
    orderReference: id(5),
    orderBatchReference: id(6),
    refundMethod: "Online",
    paidMinor: "1130",
    refundMinor: "0",
    currencyCode: "CAD",
  });
  d.remaining.mockResolvedValue({ capturedMinor: 1130n, remainingMinor: 730n });
  expect(await preview(input)).toMatchObject({ paidMinor: "1130", refundMinor: "730" });
  expect(d.scope.mock.calls[0]?.[2]).toBe(staffOrderCancellationPermission);
  // A card-machine round: what is left on the machine payment.
  d.cardMachinePayment.mockResolvedValue({
    cardMachinePaymentReference: id(8),
    preparation: { total: { amountMinor: 2486n, currencyCode: "CAD" } },
  });
  d.cardMachineRefunds.mockResolvedValue([{ amountMinor: 1486n }]);
  expect(await preview(input)).toMatchObject({
    refundMethod: "CardMachine",
    paidMinor: "2486",
    refundMinor: "1000",
  });
  // Read-only: nothing cancelled, recorded or released.
  expect(d.commit).not.toHaveBeenCalled();
  expect(d.cancel).not.toHaveBeenCalled();
  expect(d.release).not.toHaveBeenCalled();
  d.prepare.mockResolvedValueOnce({ status: "NotEligible", reason: "VersionConflict" });
  await expect(preview(input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_VERSION_CONFLICT",
  });
  await expect(
    preview({ ...input, command: { ...input.command, reasonCode: "SOLD_OUT" } }),
  ).rejects.toMatchObject({ code: "ORDER_CANCELLATION_INPUT_INVALID" });
  f.allowed.mockResolvedValue(false);
  await expect(preview(input)).rejects.toMatchObject({
    code: "ORDER_CANCELLATION_PERMISSION_DENIED",
  });
});
