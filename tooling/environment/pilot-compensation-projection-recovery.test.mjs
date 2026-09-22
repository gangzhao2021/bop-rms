import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  discover: vi.fn(),
  read: vi.fn(),
  project: vi.fn(),
  source: vi.fn(),
  candidates: vi.fn(),
}));
vi.mock("../../packages/rms/payment/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresPaymentCompensationExceptionCandidates: d.candidates,
  createPostgresPaymentCompensationExceptionSource: d.source,
}));
vi.mock("./pilot-compensation-projection.mjs", () => ({
  createInternalCompensationProjection: () => d.project,
}));
import { createInternalCompensationProjectionRecovery } from "./pilot-compensation-projection-recovery.mjs";
const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0");
function setup(afterProject) {
  const active = vi.fn(() => true),
    tx = {},
    scope = { brandReference: id(1), storeReference: id(2) };
  const recover = createInternalCompensationProjectionRecovery({
    resources: { transactions: { run: (work) => work(tx) } },
    scope,
    tenantReference: id(3),
    active,
    afterProject,
  });
  return { recover, active, tx, scope };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.candidates.mockReturnValue(d.discover);
  d.source.mockReturnValue(d.read);
  d.discover.mockResolvedValue({ items: [id(10)], nextAfterCaseReference: null });
  d.read.mockImplementation(async (_tx, reference) => ({
    source: {
      exceptionReference: reference,
      brandReference: id(1),
      storeReference: id(2),
      orderReference: id(4),
      paymentIntentReference: id(5),
      paymentAttemptReference: id(6),
    },
  }));
});
it("hydrates owner identities and repairs through existing projector without financial ports", async () => {
  const f = setup();
  expect(await f.recover()).toEqual({ recoveredCount: 1, scanComplete: true });
  expect(d.project).toHaveBeenCalledWith(
    { orderReference: id(4), paymentIntentReference: id(5), paymentAttemptReference: id(6) },
    id(10),
  );
  expect(await d.source.mock.calls[0][0].authorize(f.tx, { ...f.scope })).toBe(true);
  expect(
    await d.source.mock.calls[0][0].authorize(f.tx, { ...f.scope, storeReference: id(90) }),
  ).toBe(false);
});
it("advances only completed pages and resets after the last page", async () => {
  const f = setup();
  d.discover.mockResolvedValueOnce({
    items: [10, 11, 12, 13, 14].map(id),
    nextAfterCaseReference: id(14),
  });
  expect(await f.recover()).toEqual({ recoveredCount: 5, scanComplete: false });
  d.discover.mockResolvedValueOnce({ items: [], nextAfterCaseReference: null });
  await f.recover();
  expect(d.discover).toHaveBeenLastCalledWith(f.tx, { afterCaseReference: id(14), limit: 5 });
  await f.recover();
  expect(d.discover).toHaveBeenLastCalledWith(f.tx, { afterCaseReference: null, limit: 5 });
});
it("retries the same page after a projection failure", async () => {
  const f = setup();
  d.project.mockRejectedValueOnce(Error("write unavailable"));
  await expect(f.recover()).rejects.toThrow();
  await f.recover();
  expect(d.discover.mock.calls.map((call) => call[1].afterCaseReference)).toEqual([null, null]);
});
it("refuses missing or wrong-scope owner data and revoked authority", async () => {
  const f = setup();
  d.read.mockResolvedValueOnce(null);
  await expect(f.recover()).rejects.toThrow();
  d.read.mockResolvedValueOnce({
    source: { exceptionReference: id(10), brandReference: id(1), storeReference: id(99) },
  });
  await expect(f.recover()).rejects.toThrow();
  f.active.mockReturnValue(false);
  await expect(f.recover()).rejects.toThrow();
  expect(d.project).not.toHaveBeenCalled();
});
it("rejects non-progressing or malformed discovery before writes", async () => {
  for (const page of [
    { items: [id(10), id(10)], nextAfterCaseReference: null },
    { items: [id(10)], nextAfterCaseReference: id(10) },
    { items: ["bad"], nextAfterCaseReference: null },
  ]) {
    const f = setup();
    d.discover.mockResolvedValueOnce(page);
    await expect(f.recover()).rejects.toThrow();
  }
  expect(d.project).not.toHaveBeenCalled();
});

it("retries the same page if receipt recovery fails after projection", async () => {
  const after = vi
      .fn()
      .mockRejectedValueOnce(Error("RECEIPT_UNAVAILABLE"))
      .mockResolvedValue(undefined),
    f = setup(after);
  await expect(f.recover()).rejects.toThrow("RECEIPT_UNAVAILABLE");
  expect(await f.recover()).toEqual({ recoveredCount: 1, scanComplete: true });
  expect(after.mock.calls[0]).toEqual(d.project.mock.calls[0]);
  expect(d.discover.mock.calls.map(([, q]) => q.afterCaseReference)).toEqual([null, null]);
});
