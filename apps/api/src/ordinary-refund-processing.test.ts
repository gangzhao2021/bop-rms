import { beforeEach, expect, it, vi } from "vitest";
import { createOrdinaryRefundProcessing } from "./ordinary-refund-processing.js";
const f = vi.hoisted(() => ({
  discover: vi.fn(),
  send: vi.fn(),
  reconcile: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("@rms/payment", () => ({
  createPostgresOrdinaryRefundWorkSource: () => f.discover,
  createPostgresOrdinaryRefundSendRuntime: () => f.send,
  createPostgresOrdinaryRefundReconciliationRuntime: () => f.reconcile,
}));
vi.mock("./refund-receipt-issuance.js", () => ({ createRefundReceiptIssuance: () => f.receipt }));
const id = (n: number) => "01909979-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-15T20:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const work = {
  operationReference: id(4),
  orderReference: id(5),
  requestReference: id(6),
  workKind: "Dispatch" as const,
};
beforeEach(() => vi.resetAllMocks());
function setup() {
  const tx = {};
  const run = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));
  const identities = vi.fn(async () => ({
    dispatchReference: id(7),
    auditReference: id(8),
    approvalReference: null,
  }));
  const options = {
    payment: {
      dispatch: { scope, providerAccountReference: id(9), environment: "Test" },
      transactions: { run },
      provider: {},
      authorizeRecovery: async () => true,
      generateObservationIdentity: () => ({ observationReference: id(10), auditReference: id(11) }),
    },
    receipt: { scope: { ...scope, providerAccountReference: id(9), environment: "Test" } },
    authorizeDiscovery: async () => true,
    dispatchIdentities: identities,
    dispatchAudit: {
      reasonCode: "SYNTHETIC",
      retentionPolicyCode: "FINANCIAL",
      retentionPolicyVersion: 1,
    },
    now: () => at,
    receiptFreshAfter: () => at,
  } as unknown as Parameters<typeof createOrdinaryRefundProcessing>[0];
  return { tx, run, identities, options, service: createOrdinaryRefundProcessing(options) };
}
it("routes actual owner ports with closed scope-bound identities and separate transactions", async () => {
  const x = setup();
  const page = { afterOperationReference: null, limit: 10 };
  await x.service.discover(page);
  expect(f.discover).toHaveBeenCalledExactlyOnceWith(x.tx, page);
  await x.service.dispatch(work);
  expect(f.send).toHaveBeenCalledExactlyOnceWith(
    {
      operationReference: id(4),
      orderReference: id(5),
      requestReference: id(6),
      dispatchReference: id(7),
      auditReference: id(8),
      approvalReference: null,
    },
    x.options.dispatchAudit,
  );
  expect(f.receipt).not.toHaveBeenCalled();
  const journaled = { ...work, workKind: "Reconcile" as const };
  await x.service.reconcile(journaled);
  expect(f.reconcile).toHaveBeenCalledExactlyOnceWith({
    orderReference: id(5),
    operationReference: id(4),
    observationReference: id(10),
    auditReference: id(11),
  });
  await x.service.afterReconcile(journaled);
  expect(f.receipt).toHaveBeenCalledExactlyOnceWith(x.tx, {
    orderReference: id(5),
    observedAt: at,
    freshAfter: at,
  });
  expect(x.run).toHaveBeenCalledTimes(2);
});
it("rejects wrong work paths, injected scope and receipt scope mismatch", async () => {
  const x = setup();
  await expect(x.service.dispatch({ ...work, workKind: "Reconcile" })).rejects.toThrow();
  await expect(x.service.reconcile(work)).rejects.toThrow();
  await expect(x.service.dispatch({ ...work, tenantReference: id(20) } as never)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
  expect(() =>
    createOrdinaryRefundProcessing({
      ...x.options,
      receipt: {
        ...x.options.receipt,
        scope: { ...x.options.receipt.scope, storeReference: id(20) },
      },
    }),
  ).toThrow("ORDINARY_REFUND_PROCESSING_SCOPE_MISMATCH");
});
it("propagates receipt failure for Worker recovery without re-sending", async () => {
  const x = setup();
  f.receipt.mockRejectedValueOnce(new Error("synthetic receipt failure")).mockResolvedValue({});
  const journaled = { ...work, workKind: "Reconcile" as const };
  await expect(x.service.afterReconcile(journaled)).rejects.toThrow("synthetic receipt failure");
  await x.service.afterReconcile(journaled);
  expect(f.receipt).toHaveBeenCalledTimes(2);
  expect(f.send).not.toHaveBeenCalled();
});
