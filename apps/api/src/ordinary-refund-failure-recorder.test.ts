import { beforeEach, expect, it, vi } from "vitest";
import { createOrdinaryRefundFailureRecorder } from "./ordinary-refund-failure-recorder.js";
const f = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: f.append,
}));
const id = (n: number) => "01909979-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const candidate = {
  operationReference: id(4),
  orderReference: id(5),
  requestReference: id(6),
  workKind: "Dispatch" as const,
};
beforeEach(() => vi.resetAllMocks());
function setup() {
  const query = vi.fn();
  const tx = { query };
  let committed = false;
  const authorize = vi.fn(async () => true);
  const record = createOrdinaryRefundFailureRecorder({
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    transactions: {
      run: async (work) => {
        const result = await work(tx);
        committed = true;
        return result;
      },
    },
    authorize,
    newAuditReference: () => id(7),
    now: () => "2026-09-15T20:00:00.000Z",
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  return { record, authorize, query, committed: () => committed };
}
it("persists bounded failure evidence in its configured scope", async () => {
  const x = setup();
  await x.record(candidate, "ORDINARY_REFUND_EXECUTION_FAILED");
  expect(x.committed()).toBe(true);
  expect(x.authorize).toHaveBeenCalledTimes(2);
  expect(f.append.mock.calls[0]?.[1]).toMatchObject({
    brandId: id(2),
    storeId: id(3),
    targetId: id(4),
    actor: { type: "System" },
    afterSummary: { workKind: "Dispatch" },
    reasonCode: "ORDINARY_REFUND_EXECUTION_FAILED",
    dataClassification: "Restricted",
  });
  expect(JSON.stringify(f.append.mock.calls[0]?.[1])).not.toContain(id(5));
});
it("rejects extra payloads and arbitrary failure codes before database access", async () => {
  const x = setup();
  await expect(
    x.record({ ...candidate, error: "raw payload" } as never, "ORDINARY_REFUND_EXECUTION_FAILED"),
  ).rejects.toThrow();
  await expect(x.record(candidate, "raw error" as never)).rejects.toThrow();
  expect(x.query).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
});
it("propagates audit failure and permission withdrawal without committing", async () => {
  const x = setup();
  x.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(x.record(candidate, "ORDINARY_REFUND_EXECUTION_FAILED")).rejects.toThrow(
    "ORDINARY_REFUND_FAILURE_DENIED",
  );
  expect(x.committed()).toBe(false);
  const y = setup();
  f.append.mockRejectedValueOnce(new Error("synthetic audit outage"));
  await expect(y.record(candidate, "ORDINARY_REFUND_EXECUTION_FAILED")).rejects.toThrow(
    "synthetic audit outage",
  );
  expect(y.committed()).toBe(false);
});
