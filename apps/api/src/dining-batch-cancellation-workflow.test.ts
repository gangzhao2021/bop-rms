import { expect, it, vi } from "vitest";
import { evaluateDiningBatchCancellationWorkflow } from "./dining-batch-cancellation-workflow.js";
const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock("@bop/workflow", async (original) => ({
  ...(await original<typeof import("@bop/workflow")>()),
  createPostgresWorkflowDefinitionStore: () => ({ evaluatePublishedAction: mocks.evaluate }),
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

function workflowFixture() {
  const source = fixture(),
    record = source.record,
    tx = { query: vi.fn() };
  const authorize = vi.fn(async () => true);
  const request = {
    tenantReference: record.tenantReference,
    brandReference: record.brandReference,
    storeReference: record.storeReference,
    actorReference: id(90),
    resourceReference: record.orderReference,
    resourceVersion: 7,
    purposeCode: "BatchCheckoutExpiry",
    applicabilityCode: "DineIn",
    expectedVersionReference: record.workflowVersionReference,
    currentState: "InProgress",
    action: "CancelExpiredBatch",
    observedAt: record.cancelledAt,
  };
  let transition = {
    transitionReference: record.transitionReference,
    permissionCode: "order.batch.cancel",
    nextState: "Ready",
    effects: [] as unknown[],
  };
  mocks.evaluate.mockReset().mockImplementation(async (_request, gates) => {
    if (!(await gates.authorizeAction(tx, { transition }))) throw new Error("DENIED");
    return { transition };
  });
  return {
    input: {
      transaction: tx,
      source,
      request,
      systemActorReference: id(90),
      policy: {
        action: request.action,
        purposeCode: request.purposeCode,
        permissionCode: "order.batch.cancel",
      },
      gates: {
        authorizeResource: authorize,
        authorizeAction: authorize,
        authorizeOverride: authorize,
        evaluateRule: authorize,
      },
    },
    authorize,
    setTransition: (value: Partial<typeof transition>) => {
      transition = { ...transition, ...value };
    },
  };
}
it("requires published cancellation to preserve older Ready progress", async () => {
  const f = workflowFixture();
  expect((await evaluateDiningBatchCancellationWorkflow(f.input)).transition.nextState).toBe(
    "Ready",
  );
  expect(f.authorize).toHaveBeenCalled();
});
it.each([
  "actorReference",
  "resourceVersion",
  "currentState",
  "expectedVersionReference",
  "observedAt",
])("rejects rebound %s before policy access", async (key) => {
  const f = workflowFixture();
  const value =
    key === "resourceVersion"
      ? 8
      : key === "currentState"
        ? "Submitted"
        : key === "observedAt"
          ? "2026-09-21T00:32:00.000Z"
          : id(99);
  await expect(
    evaluateDiningBatchCancellationWorkflow({
      ...f.input,
      request: { ...f.input.request, [key]: value },
    }),
  ).rejects.toThrow();
  expect(mocks.evaluate).not.toHaveBeenCalled();
});
it.each([
  { nextState: "Cancelled" },
  { permissionCode: "order.cancel" },
  { transitionReference: id(99) },
  { effects: [{ kind: "Unhandled" }] },
])("refuses unexpected transition %j", async (change) => {
  const f = workflowFixture();
  f.setTransition(change);
  await expect(evaluateDiningBatchCancellationWorkflow(f.input)).rejects.toThrow();
});
it("retains current external authority refusal", async () => {
  const f = workflowFixture();
  f.authorize.mockResolvedValue(false);
  await expect(evaluateDiningBatchCancellationWorkflow(f.input)).rejects.toThrow();
});
