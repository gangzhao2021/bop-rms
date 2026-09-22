import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const mocks = vi.hoisted(() => ({ scan: vi.fn(), recover: vi.fn(), outcome: vi.fn() }));
vi.mock("../infrastructure/persistence/ordinary-refund-operation-store.js", () => ({
  createPostgresOrdinaryRefundWorkSource: () => mocks.scan,
  createPostgresOrdinaryRefundClaimOutcomeReader: () => mocks.outcome,
}));
vi.mock("../infrastructure/ordinary-refund-recovery-source.js", () => ({
  createPostgresOrdinaryRefundRecoverySource: () => mocks.recover,
}));
import { createPostgresOrdinaryRefundWindowSource } from "../infrastructure/ordinary-refund-window-source.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const input = {
  startsAt: "2026-09-20T08:00:00.000Z",
  endsAt: "2026-09-21T08:00:00.000Z",
  observedAt: "2026-09-22T00:00:00.000Z",
};
function fixture() {
  const candidate = {
    operationReference: id(6),
    orderReference: id(7),
    requestReference: id(8),
    workKind: "Reconcile",
  };
  const operation = {
    ...candidate,
    paymentAttemptReference: id(9),
    preparedAt: "2026-09-19T00:00:00.000Z",
    amountMinor: 1250n,
  };
  const position = {
    state: "Confirmed",
    confirmedMinor: 1250n,
    providerCreatedAt: input.startsAt,
    confirmedAt: input.endsAt,
    providerRefundReference: "re_confirmed",
    historyDigest: "sha256:" + "a".repeat(64),
  };
  mocks.scan
    .mockReset()
    .mockResolvedValue({ candidates: [candidate], nextAfterOperationReference: null });
  mocks.recover.mockReset().mockResolvedValue({ operation });
  mocks.outcome.mockReset().mockResolvedValue({ operation, position });
  const authorize = vi.fn(async () => true),
    tx = {} as ConsumerTransaction;
  const read = createPostgresOrdinaryRefundWindowSource({
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(4),
      environment: "Test",
    },
    authorize,
  });
  return { candidate, operation, position, authorize, tx, read };
}
it("counts a prior-operation refund by Provider-created time, not confirmation or capture date", async () => {
  const f = fixture();
  expect(await f.read(f.tx, input)).toMatchObject({
    refundCount: 1,
    refundedAmountMinor: 1250n,
    unresolvedOperationCount: 0,
  });
  expect(mocks.outcome).toHaveBeenCalledWith(f.tx, {
    orderReference: id(7),
    requestReference: id(8),
    paymentAttemptReference: id(9),
    observedAt: input.observedAt,
  });
});
it("excludes the ending boundary", async () => {
  const f = fixture();
  f.position.providerCreatedAt = input.endsAt;
  expect((await f.read(f.tx, input)).refundCount).toBe(0);
});
it("keeps unknown and undispatched operations explicit", async () => {
  const f = fixture();
  f.position.state = "NeedsReconciliation";
  expect((await f.read(f.tx, input)).unresolvedOperationCount).toBe(1);
  mocks.scan.mockResolvedValue({
    candidates: [{ ...f.candidate, workKind: "Dispatch" }],
    nextAfterOperationReference: null,
  });
  mocks.recover.mockClear();
  expect((await f.read(f.tx, input)).unresolvedOperationCount).toBe(1);
  expect(mocks.recover).not.toHaveBeenCalled();
});
it("rejects missing recovery and inconsistent confirmed amounts", async () => {
  const f = fixture();
  mocks.recover.mockResolvedValueOnce(null);
  await expect(f.read(f.tx, input)).rejects.toThrow();
  f.position.confirmedMinor = 1200n;
  await expect(f.read(f.tx, input)).rejects.toThrow();
});
it("continues the owner cursor and refuses duplicate operations", async () => {
  const f = fixture();
  mocks.scan
    .mockResolvedValueOnce({
      candidates: [f.candidate],
      nextAfterOperationReference: f.candidate.operationReference,
    })
    .mockResolvedValueOnce({ candidates: [], nextAfterOperationReference: null });
  expect((await f.read(f.tx, input)).scannedOperationCount).toBe(1);
  expect(mocks.scan.mock.calls[1]?.[1]).toEqual({ afterOperationReference: id(6), limit: 100 });
  mocks.scan.mockResolvedValue({
    candidates: [f.candidate, f.candidate],
    nextAfterOperationReference: null,
  });
  await expect(f.read(f.tx, input)).rejects.toThrow();
});
it("refuses current authority loss and unfinished windows", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.tx, input)).rejects.toThrow();
  await expect(f.read(f.tx, { ...input, observedAt: input.startsAt })).rejects.toThrow();
});
