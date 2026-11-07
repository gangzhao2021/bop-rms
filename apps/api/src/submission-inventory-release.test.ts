import { beforeEach, expect, it, vi } from "vitest";
import { parseSubmissionInventoryFinalValidation } from "@rms/inventory";
import { finalValidationFixture } from "../../../packages/rms/inventory/src/tests/submission-final-validation.fixture.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";
const m = vi.hoisted(() => ({
  original: vi.fn(),
  resolve: vi.fn(),
  verify: vi.fn(),
  current: vi.fn(),
  version: vi.fn(),
  release: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresSubmissionFinalValidationStore: () => ({ loadForSystemRelease: m.original }),
  createPostgresStockReservationStore: (_runner: unknown, _scope: unknown, capability: unknown) => {
    m.capability(capability);
    return {
      resolveOperation: m.resolve,
      verifySystemRelease: m.verify,
      loadCurrent: m.current,
      loadAccountLedgerVersion: m.version,
      releaseSet: m.release,
    };
  },
}));
const id = (n: number) => `0190ee72-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const occurredAt = "2026-09-21T05:00:00.000Z",
  releasedAt = "2026-09-21T05:00:30.000Z";
beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
});
function fixture() {
  const original = parseSubmissionInventoryFinalValidation(finalValidationFixture());
  const entries = original.reservationSet?.entries ?? [];
  const receipts = new Map<string, unknown>();
  const current = new Map<string, { accountReference: string; reservation: unknown }>(
    entries.map((e) => [
      e.reservation.reservationReference,
      { accountReference: e.accountReference, reservation: e.reservation },
    ]),
  );
  m.original.mockResolvedValue(original);
  m.resolve.mockImplementation(async (ref) => receipts.get(ref) ?? null);
  m.verify.mockImplementation(async (ref) => receipts.get(ref) ?? null);
  m.version.mockResolvedValue(3);
  m.current.mockImplementation(async (ref) => current.get(ref) ?? null);
  m.release.mockImplementation(async (input) => {
    const applied = input.writes.map(
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
    return { status: "Applied", setReference: input.set.setReference, entries: applied };
  });
  const authorize = vi.fn(async () => true);
  const port = createSubmissionInventoryRelease({
    scope: original,
    systemActorReference: id(10),
    reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    now: () => "2026-09-21T05:01:00.000Z",
  });
  const request = {
    source: {
      kind: "PaidWithoutFulfillableInventory/v1",
      reference: id(3),
      submissionReference: original.submissionReference,
      orderReference: original.orderReference,
      occurredAt,
    },
    releasedAt,
    authorize,
  };
  const tx = { query: vi.fn() };
  return { original, entries, receipts, current, authorize, port, request, tx };
}
it("releases the complete set once with the source reason and verifies the replay", async () => {
  const f = fixture();
  expect(await f.port.release(f.tx, f.request)).toEqual({
    status: "Released",
    entryCount: f.entries.length,
  });
  expect(m.capability).toHaveBeenCalledWith(
    expect.objectContaining({
      systemActorReference: id(10),
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    }),
  );
  const writes = m.release.mock.calls[0]?.[0].writes;
  expect(writes).toHaveLength(f.entries.length);
  expect(writes[0]).toMatchObject({
    action: "Release",
    expectedLedgerVersion: 3,
    reservation: { remainingQuantity: "0", consumedQuantity: "0", updatedAt: releasedAt },
    audit: {
      actor: { type: "System" },
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
      sourceChannel: "SYSTEM",
      occurredAt: releasedAt,
    },
  });
  // Child references are derived from the source only, so a later retry finds the same operations.
  const later = { ...f.request, releasedAt: "2026-09-21T05:00:59.000Z" };
  expect(await f.port.release(f.tx, later)).toEqual({
    status: "AlreadyApplied",
    entryCount: f.entries.length,
  });
  expect(await f.port.verify(f.tx, later)).toEqual({
    status: "AlreadyApplied",
    entryCount: f.entries.length,
  });
  expect(m.release).toHaveBeenCalledTimes(1);
  // A different source derives different child operations.
  const other = createSubmissionInventoryRelease({
    scope: f.original,
    systemActorReference: id(10),
    reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    now: () => "2026-09-21T05:01:00.000Z",
  });
  await other.release(f.tx, { ...f.request, source: { ...f.request.source, reference: id(4) } });
  const otherWrites = m.release.mock.calls[1]?.[0].writes;
  expect(otherWrites[0].operationReference).not.toBe(writes[0].operationReference);
});
it("returns stock already released by another source as a verified no-op", async () => {
  const f = fixture();
  for (const entry of f.entries)
    f.current.set(entry.reservation.reservationReference, {
      accountReference: entry.accountReference,
      reservation: {
        ...entry.reservation,
        version: 2,
        remainingQuantity: "0",
        releasedQuantity: entry.reservation.originalQuantity,
      },
    });
  expect(await f.port.release(f.tx, f.request)).toEqual({
    status: "NothingToRelease",
    reason: "AlreadyReleased",
  });
  expect(m.release).not.toHaveBeenCalled();
});
it("never releases a set whose production started, was consumed or is partly settled", async () => {
  const f = fixture();
  const [first] = f.entries;
  if (!first) throw new Error("fixture");
  const ref = first.reservation.reservationReference;
  f.current.set(ref, {
    accountReference: first.accountReference,
    reservation: { ...first.reservation, version: 2, productionStartedAt: occurredAt },
  });
  expect(await f.port.release(f.tx, f.request)).toEqual({
    status: "NotReleasable",
    reason: "ProductionStarted",
  });
  f.current.set(ref, {
    accountReference: first.accountReference,
    reservation: {
      ...first.reservation,
      version: 2,
      remainingQuantity: "0",
      releasedQuantity: first.reservation.originalQuantity,
    },
  });
  expect(await f.port.release(f.tx, f.request)).toEqual({
    status: "NotReleasable",
    reason: "PartiallySettled",
  });
  expect(m.release).not.toHaveBeenCalled();
});
it("reports untracked, missing and deferred inventory without stock writes", async () => {
  const f = fixture();
  m.original.mockResolvedValue({ ...f.original, reservationSet: null, items: [] });
  expect(await f.port.release(f.tx, f.request)).toEqual({
    status: "NothingToRelease",
    reason: "NotTracked",
  });
  m.original.mockResolvedValue(null);
  expect(await f.port.release(f.tx, f.request)).toEqual({
    status: "NotReleasable",
    reason: "NoInventoryRecord",
  });
  m.original.mockResolvedValue({ ...f.original, items: [{ disposition: "Deferred" }] });
  expect(await f.port.release(f.tx, f.request)).toEqual({
    status: "NotReleasable",
    reason: "DeferredInventory",
  });
  expect(m.release).not.toHaveBeenCalled();
});
it.each([
  "denied",
  "future",
  "beforeSource",
  "badKind",
  "otherOrder",
  "partialPrior",
  "missingLedger",
  "unverifiedReceipt",
])("fails closed for %s", async (kind) => {
  const f = fixture();
  let request = f.request;
  if (kind === "denied") f.authorize.mockResolvedValue(false);
  if (kind === "future") request = { ...request, releasedAt: "2026-09-21T05:02:00.000Z" };
  if (kind === "beforeSource") request = { ...request, releasedAt: "2026-09-21T04:59:00.000Z" };
  if (kind === "badKind") request = { ...request, source: { ...request.source, kind: "x y" } };
  if (kind === "otherOrder")
    m.original.mockResolvedValue({ ...f.original, orderReference: id(99) });
  if (kind === "partialPrior")
    m.resolve.mockImplementation(async (ref) =>
      ref === m.resolve.mock.calls[0]?.[0] ? { status: "AlreadyApplied" } : null,
    );
  if (kind === "missingLedger") m.version.mockResolvedValue(null);
  if (kind === "unverifiedReceipt")
    m.release.mockResolvedValue({ status: "Applied", entries: f.entries });
  await expect(f.port.release(f.tx, request)).rejects.toThrow();
  if (kind !== "unverifiedReceipt") expect(m.release).not.toHaveBeenCalled();
});
it("rejects verification of a release written outside the source window", async () => {
  const f = fixture();
  await f.port.release(f.tx, f.request);
  for (const [ref, receipt] of f.receipts) {
    const r = receipt as { reservation: Record<string, unknown> };
    f.receipts.set(ref, {
      ...r,
      reservation: { ...r.reservation, updatedAt: "2026-09-21T05:00:40.000Z" },
    });
  }
  await expect(f.port.verify(f.tx, f.request)).rejects.toThrow();
  expect(
    await f.port.verify(f.tx, { ...f.request, releasedAt: "2026-09-21T05:00:40.000Z" }),
  ).toEqual({ status: "AlreadyApplied", entryCount: f.entries.length });
});
