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
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresStaffOrderCancellationStore: d.ordering,
}));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createPostgresKitchenBatchCancellation: d.kitchen,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresPaymentCompensationRefundPositionSource: d.positionFactory,
}));
vi.mock("./submission-inventory-release.js", () => ({
  createSubmissionInventoryRelease: d.releaseFactory,
}));
import { KitchenBatchCancellationError } from "@rms/kitchen";
import {
  createMerchantOrderStaffCancellation,
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
  d.load.mockResolvedValue(null);
  d.prepare.mockResolvedValue({ status: "Ready", plan: { synthetic: "plan" } });
  d.commit.mockResolvedValue({ status: "Created", record });
  d.kitchen.mockReturnValue({ cancel: d.cancel });
  d.cancel.mockResolvedValue({
    status: "Cancelled",
    kitchenTicketReference: id(40),
    workItemCount: 2,
    evidenceDigest: "sha256:" + "a".repeat(64),
  });
  d.releaseFactory.mockReturnValue({ release: d.release });
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
  expect(await f.operation(f.input)).toEqual({
    status: "Cancelled",
    orderReference: id(5),
    orderBatchReference: id(6),
    cancelledAt: at,
    refundStatus: "Pending",
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
    plan: { synthetic: "plan" },
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
  // Each owner authorizes only this order, batch and staff member while the permission holds.
  const ownerAuthorize = d.ordering.mock.calls[0]?.[0].authorize;
  const identity = { orderReference: id(5), orderBatchReference: id(6), actorReference: id(2) };
  expect(await ownerAuthorize(f.tx, identity)).toBe(true);
  expect(await ownerAuthorize(f.tx, { ...identity, orderBatchReference: id(99) })).toBe(false);
  expect(await ownerAuthorize({}, identity)).toBe(false);
  f.allowed.mockResolvedValue(false);
  expect(await d.kitchen.mock.calls[0]?.[0].authorize(f.tx, identity)).toBe(false);
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
