import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ read: vi.fn(), owner: vi.fn(), factory: vi.fn(), write: vi.fn() }));
vi.mock("../../packages/rms/payment/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresPaymentCompensationExceptionSource: d.owner,
}));
vi.mock("../../packages/bop/projection/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresOrderExceptionSourceStore: d.factory,
}));
import {
  parsePaymentCompensationCase,
  createPaidWithoutFulfillableExceptionSource,
} from "../../packages/rms/payment/src/index.ts";
import { createInternalCompensationProjection } from "./pilot-compensation-projection.mjs";
const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  digest = "sha256:" + "a".repeat(64),
  at = "2026-09-21T00:00:00.000Z";
function setup() {
  const current = parsePaymentCompensationCase({
    caseReference: id(12),
    operationReference: id(13),
    dispositionReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    paymentTransactionReference: id(7),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(9),
    environment: "Test",
    originalPaymentMethod: "OnlineCard",
    reason: "PaidWithoutFulfillableOrder",
    dispositionDigest: digest,
    terminalEvidenceDigest: digest,
    sourceVersion: 1,
    sourceSnapshotDigest: digest,
    severity: "Critical",
    state: "Open",
    refundDisposition: "RefundPending",
    operationsDisposition: "Pending",
    refundReference: null,
    refundCompositionDigest: null,
    refundEvidenceDigest: null,
    refundConfirmedAt: null,
    operationsReceiptReference: null,
    operationsReceiptDigest: null,
    operationsRefundEvidenceDigest: null,
    operationsReconciledAt: null,
    openedAt: at,
    updatedAt: at,
    closedAt: null,
    version: 2,
  });
  const tx = {},
    authorize = vi.fn(async () => true),
    resources = {
      transactions: { run: (work) => work(tx) },
      credentials: { reference: () => id(40) },
    };
  const scope = { brandReference: id(2), storeReference: id(3) };
  const disposition = {
    orderReference: id(4),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(9),
  };
  const value = {
    source: createPaidWithoutFulfillableExceptionSource(current),
    sourceVersion: 2,
    resolutionEvidenceReference: null,
  };
  d.read.mockResolvedValue(value);
  return {
    current,
    value,
    disposition,
    tx,
    authorize,
    refresh: createInternalCompensationProjection({
      resources,
      scope,
      tenantReference: id(39),
      authorize,
    }),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.owner.mockReturnValue(d.read);
  d.write.mockResolvedValue({ status: "Created" });
  d.factory.mockImplementation((options) => ({
    write: async (tx, source, checkpoint) => {
      if (!(await options.authorize(tx, "Write")) || !(await options.validateSource(tx, source)))
        throw Error("invalid projection");
      return d.write(tx, source, checkpoint);
    },
  }));
});
it("projects pending Case from owner, not optimistic completion", async () => {
  const f = setup();
  await f.refresh(f.disposition, id(12));
  expect(d.write.mock.calls[0][1]).toMatchObject({
    sourceStatus: "Open",
    providerState: "Pending",
    compensationStatus: "Pending",
    sourceVersion: 2n,
    resolutionEvidenceReference: null,
  });
  expect(d.write.mock.calls[0][1]).not.toHaveProperty("amount");
});
it("projects Closed only with owned operations resolution evidence", async () => {
  const f = setup();
  const closed = parsePaymentCompensationCase({
    ...f.current,
    state: "Closed",
    refundDisposition: "ProviderConfirmed",
    operationsDisposition: "Reconciled",
    refundReference: id(31),
    refundCompositionDigest: digest,
    refundEvidenceDigest: digest,
    refundConfirmedAt: at,
    operationsReceiptReference: id(32),
    operationsReceiptDigest: digest,
    operationsRefundEvidenceDigest: digest,
    operationsReconciledAt: at,
    closedAt: at,
  });
  d.read.mockResolvedValue({
    source: createPaidWithoutFulfillableExceptionSource(closed),
    sourceVersion: 3,
    resolutionEvidenceReference: id(32),
  });
  await f.refresh(f.disposition, id(12));
  expect(d.write.mock.calls[0][1]).toMatchObject({
    sourceStatus: "Final",
    providerState: "Confirmed",
    compensationStatus: "Completed",
    resolutionEvidenceReference: id(32),
  });
  d.read.mockResolvedValue({
    source: createPaidWithoutFulfillableExceptionSource(closed),
    sourceVersion: 3,
    resolutionEvidenceReference: null,
  });
  await expect(f.refresh(f.disposition, id(12))).rejects.toThrow();
});
it("rejects missing/mismatched source and version change during write", async () => {
  const f = setup();
  d.read.mockResolvedValueOnce(null);
  await expect(f.refresh(f.disposition, id(12))).rejects.toThrow();
  await expect(f.refresh({ ...f.disposition, orderReference: id(99) }, id(12))).rejects.toThrow();
  d.read.mockResolvedValueOnce(f.value).mockResolvedValueOnce({ ...f.value, sourceVersion: 3 });
  await expect(f.refresh(f.disposition, id(12))).rejects.toThrow();
  expect(d.write).not.toHaveBeenCalled();
});
