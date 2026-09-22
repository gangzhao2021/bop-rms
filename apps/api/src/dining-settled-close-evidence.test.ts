import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inputs: vi.fn(), resolve: vi.fn() }));
vi.mock("./dining-order-closure-inputs.js", () => ({
  createDiningOrderClosureInputs: () => ({ load: mocks.inputs }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createDiningExceptionResolution: () => ({ resolve: mocks.resolve }),
}));
import { createDiningSettledCloseEvidence } from "./dining-settled-close-evidence.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0"),
  digest = "sha256:" + "a".repeat(64),
  at = "2026-09-20T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    input = {
      ...scope,
      transaction: { query: vi.fn() },
      orderReference: id(4),
      diningSessionReference: id(5),
      guestSessionReference: id(6),
      observedAt: at,
    };
  const item = {
    orderItemReference: id(7),
    orderBatchReference: id(8),
    phase: "Fulfilled",
    everAccepted: true,
    everStarted: true,
  };
  const current = {
    execution: {
      ...scope,
      orderReference: id(4),
      orderVersion: 3,
      observedAt: at,
      revisionCheckpoint: id(9),
      revisionDigest: digest,
      phase: "Fulfilled",
      kitchenEvidenceComplete: true,
      items: [item],
    },
    financial: { snapshotDigest: digest },
    priced: { snapshotDigest: digest, pendingAmendmentCount: 0 },
    cancellation: { pendingCount: 0 },
    settlement: { classification: "Settled" },
    tasks: { taskSources: [{ tasks: [] as unknown[] }] },
  };
  const fact = {
    ...scope,
    finalityReference: id(10),
    operationReference: id(11),
    providerAccountReference: id(12),
    environment: "Test",
    orderReference: id(4),
    orderVersion: 3,
    orderCheckpoint: id(9),
    classification: "Settled",
    currencyCode: "CAD",
    pricedOrderTotalMinor: "100",
    capturedMinor: "100",
    capturedOrderAllocationMinor: "100",
    capturedTipMinor: "0",
    orderEvidenceDigest:
      "sha256:" +
      createHash("sha256")
        .update(JSON.stringify([digest, digest]))
        .digest("hex"),
    paymentEvidenceDigest: digest,
    decidedAt: at,
  };
  mocks.inputs.mockResolvedValue(current);
  mocks.resolve.mockResolvedValue({ outcome: "Cleared" });
  const authorize = vi.fn(async () => true),
    source = createDiningSettledCloseEvidence({
      ...scope,
      diningScope: scope,
      paymentScope: { ...scope, providerAccountReference: id(12), environment: "Test" },
      authorize,
      authorizeKitchen: authorize,
      authorizeDining: authorize,
    });
  const task = {
    taskReference: id(20),
    scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
    source: { sourceType: "DINING_SESSION", sourceReference: id(5), snapshotDigest: digest },
    taskType: "DINING_UNPAID_BATCH_EXCEPTION",
    severityCode: "CRITICAL",
    priorityCode: "CRITICAL",
    status: "Open",
    assignmentHistory: [],
    currentAssignment: null,
    claimHistory: [],
    currentClaim: null,
    dueAt: at,
    escalationPolicyReference: id(21),
    escalationHistory: [],
    terminalOutcome: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  return { current, fact, task, authorize, run: () => source.load(input, fact) };
}
it("builds eligible evidence from complete current facts and matching finality", async () => {
  const f = setup(),
    r = await f.run();
  expect(r.decision.eligible).toBe(true);
  expect(r.evidence.criticalBlockingTaskCount).toBe(0);
});
it.each([
  "orderVersion",
  "orderCheckpoint",
  "paymentEvidenceDigest",
  "orderEvidenceDigest",
  "decidedAt",
])("rejects stale finality %s", async (key) => {
  const f = setup();
  Object.assign(f.fact, {
    [key]:
      key === "orderVersion"
        ? 2
        : key === "decidedAt"
          ? "2026-09-19T00:00:00.000Z"
          : key.endsWith("Digest")
            ? "sha256:" + "b".repeat(64)
            : id(99),
  });
  await expect(f.run()).rejects.toThrow();
});
it.each(["Cleared", "NotApplicable", "Blocking", "Unknown"])(
  "uses owning Dining verdict %s",
  async (outcome) => {
    const f = setup();
    f.current.tasks.taskSources[0]?.tasks.push(f.task);
    mocks.resolve.mockResolvedValue({ outcome });
    const r = await f.run();
    expect(r.decision.eligible).toBe(outcome === "Cleared" || outcome === "NotApplicable");
  },
);
it("unknown critical type remains incomplete", async () => {
  const f = setup();
  f.current.tasks.taskSources[0]?.tasks.push({ ...f.task, taskType: "NEW_CRITICAL_EXCEPTION" });
  const r = await f.run();
  expect(r.evidence.criticalBlockingTaskCount).toBeNull();
  expect(r.decision.eligible).toBe(false);
});
it("pending cancellation still blocks a settled order", async () => {
  const f = setup();
  f.current.cancellation.pendingCount = 1;
  expect((await f.run()).decision.reasons).toContain("CANCELLATION_PENDING");
});
it("requires current authority after facts", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
});
