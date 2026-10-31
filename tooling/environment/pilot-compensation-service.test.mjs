import console from "node:console";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  project: vi.fn(),
  receipt: vi.fn(),
  audit: vi.fn(),
  disposition: vi.fn(),
  execute: vi.fn(),
  resolve: vi.fn(),
  operations: vi.fn(),
  discover: vi.fn(),
}));
vi.mock("../../apps/api/dist/payment-compensation-composition.js", () => ({
  createPaymentCompensationComposition: mocks.compose,
}));
vi.mock("../../packages/rms/payment/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresPaymentCompensationOperationsStore: mocks.operations,
}));
vi.mock("./pilot-compensation-candidates.mjs", () => ({
  createInternalCompensationCandidates: () => ({ discover: mocks.discover }),
}));
vi.mock("../../apps/api/dist/payment-compensation-disposition-evidence.js", () => ({
  createPaymentCompensationDispositionEvidence: () => mocks.disposition,
}));
vi.mock("../../packages/bop/audit/src/index.ts", async (original) => ({
  ...(await original()),
  appendAuditRecordInTransaction: mocks.audit,
}));
vi.mock("./pilot-compensation-receipt.mjs", () => ({
  createInternalCompensationReceiptRecovery: () => mocks.receipt,
}));
vi.mock("./pilot-compensation-projection.mjs", () => ({
  createInternalCompensationProjection: () => mocks.project,
}));
import { createInternalCompensationService } from "./pilot-compensation-service.mjs";
const id = (n) => "0190fa77-0000-7000-8000-" + String(n).padStart(12, "0");
const d = {
  dispositionReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
  orderBatchReference: id(5),
  submissionReference: id(6),
  paymentTransactionReference: id(7),
  paymentIntentReference: id(8),
  paymentAttemptReference: id(9),
  paymentEventReference: id(10),
  sourceVersion: 1,
  sourceCheckpoint: id(11),
  sourceDigest: "sha256:" + "a".repeat(64),
  evaluatedAt: "2026-09-21T00:00:00.000Z",
  disposition: "PaidWithoutFulfillableOrder",
  reason: "SubmissionCancelled",
  kitchenReleaseDisposition: "Blocked",
};

function setup() {
  const scope = { brandReference: d.brandReference, storeReference: d.storeReference };
  const resources = {
    scope,
    publicProfile: {
      binding: { ...scope, tenantReference: id(15), validUntil: "2026-09-22T00:00:00.000Z" },
    },
    now: vi.fn(() => "2026-09-21T01:00:00.000Z"),
    transactions: { run: (work) => work({}) },
    credentials: { reference: () => id(16) },
  };
  const simulator = {
      adapter: {
        retrieveIntent: vi.fn(async () => ({ kind: "Snapshot" })),
        refundPayment: vi.fn(async () => ({ kind: "Snapshot" })),
      },
      close: vi.fn(),
    },
    factory = vi.fn(async () => simulator);
  const options = {
    resources,
    providerAccountReference: id(17),
    createSimulatedProvider: factory,
    additionalRefundOwners: [],
  };
  return { resources, simulator, factory, options };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  mocks.disposition.mockResolvedValue(true);
  mocks.compose.mockResolvedValue({ execute: mocks.execute });
  mocks.execute.mockResolvedValue({ status: "RefundPending" });
  mocks.operations.mockReturnValue({ resolve: mocks.resolve });
  mocks.discover.mockResolvedValue({ candidates: [], nextAfterDispositionReference: null });
});
afterEach(() => vi.unstubAllEnvs());
it("constructs/discovers without Provider calls and binds one exact runtime on execution", async () => {
  const f = setup(),
    service = createInternalCompensationService(f.options);
  await service.discover({ afterDispositionReference: null, limit: 5 });
  expect(mocks.compose).not.toHaveBeenCalled();
  expect(f.factory).not.toHaveBeenCalled();
  await expect(service.execute(d)).resolves.toEqual({ status: "RefundPending" });
  expect(mocks.execute).toHaveBeenCalledWith(d);
  const config = mocks.compose.mock.calls[0][0];
  expect(config.scope).toEqual({
    ...f.resources.scope,
    environment: "Test",
    providerAccountReference: id(17),
  });
  expect(await config.otherRefunds()).toEqual({ confirmedMinor: 0n, pendingMinor: 0n, version: 1 });
  expect(await config.operations.validateEvidence()).toBe(false);
});
it("permits only exact persisted operator receipt consumption, never background acknowledgment", async () => {
  const f = setup();
  await createInternalCompensationService(f.options).execute(d);
  const config = mocks.compose.mock.calls[0][0],
    access = {
      ...f.resources.scope,
      caseReference: mocks.operations.mock.calls[0][0].scope
        ? config.references.caseFor({
            environment: "Test",
            paymentTransactionReference: d.paymentTransactionReference,
            paymentAttemptReference: d.paymentAttemptReference,
            orderReference: d.orderReference,
            reason: "PaidWithoutFulfillableOrder",
            purpose: "CompensatePaidWithoutFulfillableOrder",
          })
        : null,
      purpose: "ReconcilePaidWithoutFulfillableOrder",
      action: "Read",
      actorReference: null,
    };
  expect(await config.operations.authorize({}, access)).toBe(true);
  expect(
    await config.operations.authorize({}, { ...access, action: "Record", actorReference: id(40) }),
  ).toBe(false);
  const receipt = { compensationCaseReference: access.caseReference, actorReference: id(40) };
  mocks.resolve.mockResolvedValue(receipt);
  expect(await config.authorizeOperations(receipt)).toBe(true);
  expect(await config.authorizeOperations({ ...receipt, actorReference: id(41) })).toBe(false);
});
it("closes shared simulator after each request including a failure", async () => {
  const f = setup();
  await createInternalCompensationService(f.options).execute(d);
  const config = mocks.compose.mock.calls[0][0],
    request = { context: { ...f.resources.scope, environment: "Test" } };
  await config.provider.retrieveIntent(request);
  expect(f.simulator.close).toHaveBeenCalledOnce();
  f.simulator.adapter.refundPayment.mockRejectedValueOnce(new Error("synthetic"));
  await expect(config.provider.refundPayment(request)).rejects.toThrow();
  expect(f.simulator.close).toHaveBeenCalledTimes(2);
  await expect(
    config.provider.refundPayment({ context: { ...request.context, environment: "Live" } }),
  ).rejects.toThrow();
  expect(f.factory).toHaveBeenCalledTimes(2);
});
it("denies unsupported owners, scope changes and expired configuration", async () => {
  const f = setup();
  expect(() =>
    createInternalCompensationService({ ...f.options, additionalRefundOwners: ["unsupported"] }),
  ).toThrow();
  const service = createInternalCompensationService(f.options);
  await expect(service.execute({ ...d, storeReference: id(99) })).rejects.toThrow();
  f.resources.now.mockReturnValue("2026-09-22T00:00:00.000Z");
  await expect(service.execute(d)).rejects.toThrow();
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createInternalCompensationService(f.options)).toThrow();
  expect(mocks.compose).not.toHaveBeenCalled();
});

it("records only a fixed redacted failure audit under current disposition authority", async () => {
  const f = setup(),
    service = createInternalCompensationService(f.options);
  await service.recordFailure(d, "COMPENSATION_EXECUTION_FAILED");
  expect(mocks.audit).toHaveBeenCalledOnce();
  expect(mocks.audit.mock.calls[0][1]).toMatchObject({
    actor: { type: "System" },
    actionCode: "PAYMENT_COMPENSATION_EXECUTION_FAILED",
    reasonCode: "COMPENSATION_EXECUTION_FAILED",
    dataClassification: "Restricted",
  });
  expect(Object.keys(mocks.audit.mock.calls[0][1])).not.toContain("summary");
  await expect(service.recordFailure(d, "private-error")).rejects.toThrow();
  mocks.disposition.mockResolvedValue(false);
  await expect(service.recordFailure(d, "COMPENSATION_EXECUTION_FAILED")).rejects.toThrow();
  expect(mocks.audit).toHaveBeenCalledOnce();
});

it("repairs receipts after projection and propagates recovery failures without executing compensation", async () => {
  const f = setup(),
    s = createInternalCompensationService(f.options);
  mocks.project.mockResolvedValue({ status: "Existing" });
  await expect(s.afterExecute(d)).resolves.toEqual({ status: "Existing" });
  expect(mocks.receipt.mock.calls[0]).toEqual(mocks.project.mock.calls[0]);
  expect(mocks.execute).not.toHaveBeenCalled();
  mocks.receipt.mockRejectedValueOnce(Error("RECEIPT_UNAVAILABLE"));
  await expect(s.afterExecute(d)).rejects.toThrow("RECEIPT_UNAVAILABLE");
});

it("reports only bounded execution codes once and preserves the original failure", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const service = createInternalCompensationService(setup().options);
    const failure = Object.assign(Error("private-provider-canary"), {
      code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
    });
    mocks.execute.mockRejectedValue(failure);
    await expect(service.execute(d)).rejects.toBe(failure);
    await expect(service.execute(d)).rejects.toBe(failure);
    const untrusted = Object.assign(Error("private-actor-canary"), { code: "private-code-canary" });
    mocks.execute.mockRejectedValue(untrusted);
    await expect(service.execute(d)).rejects.toBe(untrusted);
    expect(log.mock.calls).toEqual([
      ["PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE"],
      ["PAYMENT_COMPENSATION_UNAVAILABLE"],
    ]);
  } finally {
    log.mockRestore();
  }
});
