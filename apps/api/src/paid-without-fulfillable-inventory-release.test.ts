import { beforeEach, expect, it, vi } from "vitest";
import { createPaidWithoutFulfillableInventoryRelease } from "./paid-without-fulfillable-inventory-release.js";
const m = vi.hoisted(() => ({
  load: vi.fn(),
  readerScope: vi.fn(),
  options: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderPaymentDispositionReader: (scope: unknown) => {
    m.readerScope(scope);
    return { loadByPaymentEvent: m.load };
  },
}));
vi.mock("./submission-inventory-release.js", () => ({
  createSubmissionInventoryRelease: (options: unknown) => {
    m.options(options);
    return { release: m.release, verify: vi.fn() };
  },
}));
const id = (n: number) => `0190ee72-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const now = "2026-09-21T05:01:00.000Z";
beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
});
function fixture() {
  const disposition = {
    dispositionReference: id(20),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    submissionReference: id(6),
    paymentTransactionReference: id(7),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(9),
    paymentEventReference: id(10),
    sourceVersion: 2,
    sourceCheckpoint: id(11),
    sourceDigest: "sha256:" + "a".repeat(64),
    evaluatedAt: "2026-09-21T05:00:00.000Z",
    disposition: "PaidWithoutFulfillableOrder",
    reason: "CapacityExpired",
    kitchenReleaseDisposition: "Blocked",
  };
  m.load.mockResolvedValue({ record: disposition, orderConfirmedEvent: null });
  m.release.mockResolvedValue({ status: "Released", entryCount: 2 });
  const authorize = vi.fn(async () => true);
  const tx = { query: vi.fn() };
  const port = createPaidWithoutFulfillableInventoryRelease({
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    systemActorReference: id(30),
    now: () => now,
    authorize,
  });
  return { disposition, authorize, tx, port };
}
it("re-reads the Ordering disposition and releases its submission with the disposition identity", async () => {
  const f = fixture();
  expect(await f.port(f.tx, f.disposition)).toEqual({ status: "Released", entryCount: 2 });
  expect(m.readerScope).toHaveBeenCalledWith({ brandReference: id(2), storeReference: id(3) });
  expect(m.options).toHaveBeenCalledWith(
    expect.objectContaining({
      systemActorReference: id(30),
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    }),
  );
  expect(m.load).toHaveBeenCalledWith({ transaction: f.tx, paymentEventReference: id(10) });
  const [tx, request] = m.release.mock.calls[0] ?? [];
  expect(tx).toBe(f.tx);
  expect(request).toMatchObject({
    source: {
      kind: "PaidWithoutFulfillableInventory/v1",
      reference: id(20),
      submissionReference: id(6),
      orderReference: id(4),
      occurredAt: "2026-09-21T05:00:00.000Z",
    },
    releasedAt: now,
  });
  expect(await request.authorize()).toBe(true);
  expect(f.authorize).toHaveBeenLastCalledWith(
    f.tx,
    expect.objectContaining({ dispositionReference: id(20) }),
  );
});
it("passes verified no-op and staff-left results through unchanged", async () => {
  const f = fixture();
  for (const result of [
    { status: "AlreadyApplied", entryCount: 2 },
    { status: "NothingToRelease", reason: "AlreadyReleased" },
    { status: "NotReleasable", reason: "ProductionStarted" },
  ]) {
    m.release.mockResolvedValueOnce(result);
    expect(await f.port(f.tx, f.disposition)).toEqual(result);
  }
});
it.each(["denied", "missing", "changed", "otherStore", "confirmed", "future"])(
  "fails closed before any release for %s",
  async (kind) => {
    const f = fixture();
    let value: Record<string, unknown> = f.disposition;
    if (kind === "denied") f.authorize.mockResolvedValue(false);
    if (kind === "missing") m.load.mockResolvedValue(null);
    if (kind === "changed")
      m.load.mockResolvedValue({
        record: { ...f.disposition, reason: "SubmissionCancelled" },
        orderConfirmedEvent: null,
      });
    if (kind === "otherStore") value = { ...f.disposition, storeReference: id(99) };
    if (kind === "confirmed") {
      value = {
        ...Object.fromEntries(
          Object.entries(f.disposition).filter(
            ([key]) => key !== "reason" && key !== "kitchenReleaseDisposition",
          ),
        ),
        disposition: "Confirmed",
        confirmationReference: id(40),
        sourceSnapshotDigest: "sha256:" + "b".repeat(64),
        confirmedAt: "2026-09-21T05:00:00.000Z",
      };
    }
    if (kind === "future") value = { ...f.disposition, evaluatedAt: "2026-09-21T05:02:00.000Z" };
    await expect(f.port(f.tx, value)).rejects.toThrow();
    expect(m.release).not.toHaveBeenCalled();
  },
);
