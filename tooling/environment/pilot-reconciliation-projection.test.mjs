import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ runner: vi.fn(), store: vi.fn(), write: vi.fn() }));
vi.mock("./pilot-reconciliation-exceptions.mjs", () => ({
  createInternalReconciliationExceptionPageRunner: d.runner,
}));
vi.mock("../../packages/bop/projection/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresOrderExceptionSourceStore: d.store,
}));
import { createInternalReconciliationProjection } from "./pilot-reconciliation-projection.mjs";
const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z";
function setup() {
  const tx = {},
    scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const source = {
    exceptionReference: id(10),
    brandReference: id(2),
    storeReference: id(3),
    paymentIntentReference: id(4),
    paymentAttemptReference: id(5),
    orderReference: id(6),
    kind: "ReconciliationAmountMismatch",
    severity: "Error",
    state: "Open",
    refundDisposition: "NotApplicable",
    operationsDisposition: "NotApplicable",
    openedAt: at,
    updatedAt: at,
    closedAt: null,
  };
  const page = { items: [source], nextAfterExceptionReference: null },
    context = { tx, scope, page, authorize: () => true, reread: vi.fn(async () => page) },
    inputs = [];
  d.runner.mockImplementation((_r, consume) => async (input) => {
    inputs.push(input);
    return consume(context);
  });
  return {
    source,
    page,
    context,
    inputs,
    recover: createInternalReconciliationProjection({ credentials: { reference: () => id(90) } }),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.store.mockImplementation((options) => ({
    write: async (tx, source, checkpoint) => {
      if (!(await options.authorize(tx, "Write")) || !(await options.validateSource(tx, source)))
        throw Error("source changed");
      return d.write(tx, source, checkpoint);
    },
  }));
});
it("projects only owned Open state and revalidates source without assuming refund or Provider confirmation", async () => {
  const f = setup();
  expect(await f.recover()).toEqual({ projectedCount: 1, scanComplete: true });
  expect(d.write.mock.calls[0][1]).toMatchObject({
    kind: "PaymentReconciliationDifference",
    sourceStatus: "Open",
    providerState: "Unknown",
    compensationStatus: "NotRequested",
    sourceVersion: 2n,
  });
  expect(f.context.reread).toHaveBeenCalledTimes(1);
});
it("keeps unlinked exceptions visible and refuses changed owner page", async () => {
  const f = setup();
  f.source.orderReference = null;
  await f.recover();
  expect(d.write.mock.calls[0][1]).toMatchObject({ orderReference: null, sourceVersion: 1n });
  d.write.mockClear();
  f.source.orderReference = id(6);
  f.context.reread.mockResolvedValueOnce({ items: [], nextAfterExceptionReference: null });
  await expect(f.recover()).rejects.toThrow();
  expect(d.write).not.toHaveBeenCalled();
});
it("retains cursor after failure and resets only after completed scan", async () => {
  const f = setup();
  f.page.items = [10, 11, 12, 13, 14].map((n) => ({ ...f.source, exceptionReference: id(n) }));
  f.page.nextAfterExceptionReference = id(14);
  d.write.mockRejectedValueOnce(Error("write failed"));
  await expect(f.recover()).rejects.toThrow();
  expect(await f.recover()).toEqual({ projectedCount: 5, scanComplete: false });
  f.page.items = [];
  f.page.nextAfterExceptionReference = null;
  await f.recover();
  await f.recover();
  expect(f.inputs.map((v) => v.afterExceptionReference)).toEqual([null, null, id(14), null]);
});
it("rejects wrong scope, revoked authority and malformed cursor", async () => {
  const f = setup();
  f.source.storeReference = id(99);
  await expect(f.recover()).rejects.toThrow();
  f.source.storeReference = id(3);
  f.context.authorize = () => false;
  await expect(f.recover()).rejects.toThrow();
  f.context.authorize = () => true;
  f.page.nextAfterExceptionReference = id(10);
  await expect(f.recover()).rejects.toThrow();
  expect(d.write).not.toHaveBeenCalled();
});
