import { beforeEach, expect, it, vi } from "vitest";
import { parseSubmissionInventoryFinalValidation } from "@rms/inventory";
import { finalValidationFixture } from "../../../packages/rms/inventory/src/tests/submission-final-validation.fixture.js";
import { createDiningBatchCancellationInventory } from "./dining-batch-cancellation-inventory.js";
const m = vi.hoisted(() => ({
  lookup: vi.fn(),
  original: vi.fn(),
  operation: vi.fn(),
  current: vi.fn(),
  version: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderBatchCheckoutCancellationReader: () => ({ loadOperation: m.lookup }),
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresSubmissionFinalValidationStore: () => ({ loadForSystemRelease: m.original }),
  createPostgresStockReservationStore: () => ({
    resolveOperation: m.operation,
    verifySystemRelease: m.operation,
    loadCurrent: m.current,
    loadAccountLedgerVersion: m.version,
    releaseSet: m.release,
  }),
}));
const id = (n: number) => `0190ee72-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
});
function fixture() {
  const original = parseSubmissionInventoryFinalValidation(finalValidationFixture());
  const record = {
    tenantReference: original.tenantReference,
    brandReference: original.brandReference,
    storeReference: original.storeReference,
    orderReference: original.orderReference,
    submissionReference: original.submissionReference,
    orderBatchReference: id(1),
    paymentOperationReference: id(2),
    cancellationReference: id(3),
    operationReference: id(4),
    expiryRecordReference: id(5),
    expiryEvidenceDigest: "sha256:" + "a".repeat(64),
    expectedOrderVersion: 1,
    cancelledOrderVersion: 2,
    expectedSourceCheckpoint: id(6),
    workflowVersionReference: id(7),
    transitionReference: id(8),
    orderItemReferences: [id(9)],
    cancelledAt: "2026-09-21T05:00:00.000Z",
    phase: "Cancelled",
    reasonCode: "CHECKOUT_DEADLINE_REACHED",
  };
  const receipts = new Map<string, unknown>();
  m.lookup.mockResolvedValue(record);
  m.original.mockResolvedValue(original);
  m.operation.mockImplementation(async (ref) => receipts.get(ref) ?? null);
  m.version.mockResolvedValue(3);
  m.current.mockImplementation(async (ref) => {
    const entry = original.reservationSet?.entries.find(
      (e) => e.reservation.reservationReference === ref,
    );
    return entry
      ? { accountReference: entry.accountReference, reservation: entry.reservation }
      : null;
  });
  m.release.mockImplementation(async (input) => {
    const entries = input.writes.map(
      (w: {
        operationReference: string;
        reservation: unknown;
        movementReference: string;
        audit: { auditId: string };
      }) => {
        const receipt = {
          status: "Applied",
          reservation: w.reservation,
          movementReference: w.movementReference,
          auditReference: w.audit.auditId,
        };
        receipts.set(w.operationReference, receipt);
        return receipt;
      },
    );
    return { status: "Applied", setReference: input.set.setReference, entries };
  });
  const authorize = vi.fn(async () => true),
    tx = { query: vi.fn() },
    port = createDiningBatchCancellationInventory({
      scope: record,
      systemActorReference: id(10),
      now: () => "2026-09-21T05:01:00.000Z",
      authorize,
    });
  return { record, original, receipts, authorize, tx, port };
}
it("releases the complete actual source set and verifies stable original receipts on retry", async () => {
  const f = fixture();
  expect(await f.port(f.tx, { mode: "Release", cancellation: f.record })).toBe(true);
  const writes = m.release.mock.calls[0]?.[0].writes;
  expect(writes.length).toBe(f.original.reservationSet?.entries.length);
  expect(
    new Set(writes.map((w: { operationReference: string }) => w.operationReference)).size,
  ).toBe(writes.length);
  expect(writes[0]).toMatchObject({
    action: "Release",
    expectedLedgerVersion: 3,
    audit: { actor: { type: "System" } },
    reservation: { remainingQuantity: "0", consumedQuantity: "0" },
  });
  expect(await f.port(f.tx, { mode: "Verify", cancellation: f.record })).toBe(true);
  expect(m.release).toHaveBeenCalledTimes(1);
});
it.each([
  "missingCancellation",
  "changedCancellation",
  "missingInventory",
  "deferred",
  "missingCurrent",
  "missingLedger",
  "missingReceipt",
])("rejects %s", async (kind) => {
  const f = fixture();
  if (kind === "missingCancellation") m.lookup.mockResolvedValue(null);
  if (kind === "changedCancellation")
    m.lookup.mockResolvedValue({ ...f.record, cancellationReference: id(999) });
  if (kind === "missingInventory") m.original.mockResolvedValue(null);
  if (kind === "deferred")
    m.original.mockResolvedValue({ ...f.original, items: [{ disposition: "Deferred" }] });
  if (kind === "missingCurrent") m.current.mockResolvedValue(null);
  if (kind === "missingLedger") m.version.mockResolvedValue(null);
  await expect(
    f.port(f.tx, {
      mode: kind === "missingReceipt" ? "Verify" : "Release",
      cancellation: f.record,
    }),
  ).rejects.toThrow();
  expect(m.release).not.toHaveBeenCalled();
});
it("refuses an unverified receipt returned after release", async () => {
  const f = fixture();
  m.release.mockResolvedValue({ status: "Applied", entries: f.original.reservationSet?.entries });
  await expect(f.port(f.tx, { mode: "Release", cancellation: f.record })).rejects.toThrow();
});
it("does not execute again when Release encounters prior child operations", async () => {
  const f = fixture();
  await f.port(f.tx, { mode: "Release", cancellation: f.record });
  await expect(f.port(f.tx, { mode: "Release", cancellation: f.record })).rejects.toThrow();
  expect(m.release).toHaveBeenCalledTimes(1);
});
it("accepts owner-validated untracked inventory without creating stock writes", async () => {
  const f = fixture();
  m.original.mockResolvedValue({
    ...f.original,
    reservationSet: null,
    items: [{ disposition: "NotTracked" }],
  });
  expect(await f.port(f.tx, { mode: "Release", cancellation: f.record })).toBe(true);
  expect(m.release).not.toHaveBeenCalled();
});
it("rejects current authority denial before any owner read", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.port(f.tx, { mode: "Release", cancellation: f.record })).rejects.toThrow();
  expect(m.lookup).not.toHaveBeenCalled();
});
