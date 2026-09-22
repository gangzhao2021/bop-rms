import { expect, it, vi } from "vitest";
import { createDiningBatchCancellation } from "./dining-batch-cancellation.js";
const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  lookup: vi.fn(),
  source: vi.fn(),
  workflow: vi.fn(),
  append: vi.fn(),
}));
vi.mock("@rms/payment", () => ({
  createPostgresPaymentOperationFence: () => ({ acquire: mocks.fence }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderBatchCheckoutCancellationReader: () => ({ loadOperation: mocks.lookup }),
  createPostgresOrderBatchCheckoutCancellationStore: (options: unknown) => ({
    append: (tx: unknown, record: unknown) => mocks.append(tx, record, options),
  }),
}));
vi.mock("./dining-batch-cancellation-source.js", () => ({
  createDiningBatchCancellationSource: () => ({ load: mocks.source }),
}));
vi.mock("./dining-batch-cancellation-workflow.js", () => ({
  evaluateDiningBatchCancellationWorkflow: mocks.workflow,
}));
const id = (n: number) => `0190ee34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture() {
  const identity = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    submissionReference: id(6),
    paymentOperationReference: id(7),
  };
  const expiry = {
    ...identity,
    commitmentReference: id(8),
    recordReference: id(9),
    previousRecordReference: null,
    version: 1,
    paymentRequestedAt: "2026-09-21T00:00:00.000Z",
    capacityExpiresAt: "2026-09-21T00:30:00.000Z",
    observedAt: "2026-09-21T00:31:00.000Z",
    evidenceDigest: "sha256:" + "a".repeat(64),
    status: "PaymentFailed",
    paymentEvidence: {
      paymentIntentReference: id(10),
      paymentAttemptReference: id(11),
      paymentEventReference: id(12),
      outcome: "Failed",
      occurredAt: "2026-09-21T00:10:00.000Z",
    },
  };
  const record = {
    ...identity,
    cancellationReference: id(13),
    operationReference: id(14),
    expiryRecordReference: id(9),
    expiryEvidenceDigest: expiry.evidenceDigest,
    expectedOrderVersion: 7,
    cancelledOrderVersion: 8,
    expectedSourceCheckpoint: id(15),
    workflowVersionReference: id(16),
    transitionReference: id(17),
    orderItemReferences: [id(18)],
    cancelledAt: expiry.observedAt,
    phase: "Cancelled",
    reasonCode: "CHECKOUT_DEADLINE_REACHED",
  };
  const items = [
    {
      orderBatchReference: id(19),
      orderItemReference: id(20),
      phase: "Ready" as const,
      everAccepted: true,
      everStarted: true,
    },
    {
      orderBatchReference: id(5),
      orderItemReference: id(18),
      phase: "Submitted" as const,
      everAccepted: false,
      everStarted: false,
    },
  ] as const;
  return { record, expiry, items };
}

function composition() {
  const f = fixture(),
    tx = { query: vi.fn() },
    authorize = vi.fn(async () => true);
  let rollback = false,
    seq = 90;
  const newReference = vi.fn(() => id(seq++));
  const inventory = vi.fn(async () => true);
  mocks.fence.mockReset().mockResolvedValue(undefined);
  mocks.lookup.mockReset().mockImplementation(async () => {
    expect(mocks.fence).toHaveBeenCalledTimes(1);
    return null;
  });
  const evidence = {
    expiry: f.expiry,
    items: f.items,
    orderVersion: 7,
    checkpoint: f.record.expectedSourceCheckpoint,
    observedAt: f.record.cancelledAt,
    progress: { phase: "InProgress" },
  };
  mocks.source.mockReset().mockResolvedValue(evidence);
  mocks.workflow.mockReset().mockResolvedValue({});
  const resolvePolicy = vi.fn(async () => ({
    systemActorReference: id(89),
    workflowVersionReference: f.record.workflowVersionReference,
    transitionReference: f.record.transitionReference,
    policy: {
      action: "CancelExpiredBatch",
      purposeCode: "BatchCheckoutExpiry",
      permissionCode: "order.batch.cancel",
    },
    gates: {
      authorizeResource: authorize,
      authorizeAction: authorize,
      authorizeOverride: authorize,
      evaluateRule: authorize,
    },
  }));
  mocks.append.mockReset().mockImplementation(async (transaction, record, options) => {
    expect(transaction).toBe(tx);
    expect(await options.fence(tx, record)).toBe(true);
    expect(await options.source(tx, record)).toBe(evidence);
    await options.workflow(tx, record);
    await options.audit(record);
    return { status: "Created", record };
  });
  const service = createDiningBatchCancellation({
    scope: f.record,
    now: () => f.record.cancelledAt,
    newReference,
    inventory,
    authorize,
    authorizeKitchen: authorize,
    authorizeDining: authorize,
    resolvePolicy,
    transactions: {
      async run(work) {
        try {
          return await work(tx);
        } catch (error) {
          rollback = true;
          throw error;
        }
      },
    },
  });
  return {
    f,
    service,
    tx,
    authorize,
    resolvePolicy,
    newReference,
    inventory,
    input: { operationReference: f.record.operationReference, expiry: f.expiry },
    rolledBack: () => rollback,
  };
}
it("retains one transaction through fence, lookup, current source, policy and append", async () => {
  const f = composition(),
    result = await f.service.cancel(f.input);
  expect(result.status).toBe("Created");
  expect(f.inventory).toHaveBeenCalledWith(f.tx, { mode: "Release", cancellation: result.record });
  expect(f.inventory.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.append.mock.invocationCallOrder[0] ?? 0,
  );
  expect(result.record.expectedSourceCheckpoint).toBe(f.f.record.expectedSourceCheckpoint);
  expect(mocks.workflow.mock.calls[0]?.[0].transaction).toBe(f.tx);
  expect(mocks.workflow.mock.calls[0]?.[0].request.currentState).toBe("InProgress");
});
it("returns original operation without regenerating timestamp, references or workflow", async () => {
  const f = composition();
  mocks.lookup.mockResolvedValue(f.f.record);
  const result = await f.service.cancel(f.input);
  expect(result).toEqual({ status: "Existing", record: f.f.record });
  expect(f.newReference).not.toHaveBeenCalled();
  expect(mocks.source).not.toHaveBeenCalled();
  expect(f.resolvePolicy).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
  expect(f.inventory).toHaveBeenCalledWith(f.tx, { mode: "Verify", cancellation: f.f.record });
});
it("rejects an existing operation rebound to a different expiry", async () => {
  const f = composition();
  mocks.lookup.mockResolvedValue({ ...f.f.record, expiryRecordReference: id(99) });
  await expect(f.service.cancel(f.input)).rejects.toThrow();
  expect(mocks.append).not.toHaveBeenCalled();
});
it.each(["authority", "source", "workflow", "write", "inventory"])(
  "rolls back failed %s",
  async (kind) => {
    const f = composition();
    if (kind === "authority") f.authorize.mockResolvedValue(false);
    if (kind === "source") mocks.source.mockRejectedValue(new Error("SOURCE"));
    if (kind === "workflow") mocks.workflow.mockRejectedValue(new Error("WORKFLOW"));
    if (kind === "write") mocks.append.mockRejectedValue(new Error("WRITE"));
    if (kind === "inventory") f.inventory.mockRejectedValue(new Error("INVENTORY"));
    await expect(f.service.cancel(f.input)).rejects.toThrow(
      "DINING_BATCH_CANCELLATION_UNAVAILABLE",
    );
    expect(f.rolledBack()).toBe(true);
  },
);

it.each(["Release", "Verify"])(
  "refuses successful cancellation when Inventory %s is unproven",
  async (mode) => {
    const f = composition();
    if (mode === "Verify") mocks.lookup.mockResolvedValue(f.f.record);
    f.inventory.mockResolvedValue(false);
    await expect(f.service.cancel(f.input)).rejects.toThrow(
      "DINING_BATCH_CANCELLATION_UNAVAILABLE",
    );
    expect(f.rolledBack()).toBe(true);
  },
);
it("rechecks cancellation authority after verifying original Inventory completion", async () => {
  const f = composition();
  mocks.lookup.mockResolvedValue(f.f.record);
  f.inventory.mockImplementation(async () => {
    f.authorize.mockResolvedValue(false);
    return true;
  });
  await expect(f.service.cancel(f.input)).rejects.toThrow("DINING_BATCH_CANCELLATION_UNAVAILABLE");
  expect(f.rolledBack()).toBe(true);
});
