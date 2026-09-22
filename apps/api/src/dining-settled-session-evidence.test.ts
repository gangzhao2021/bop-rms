import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ load: vi.fn(), summary: vi.fn(), resolve: vi.fn() }));
vi.mock("./dining-session-closure-inputs.js", () => ({
  createDiningSessionClosureInputs: () => ({ load: mock.load }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  summarizeOrderItemProgress: mock.summary,
}));
vi.mock("@bop/task", () => ({ createTaskRecord: (task: unknown) => task }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningExceptionTaskSource: () => ({ load: vi.fn() }),
  createDiningExceptionResolution: () => ({ resolve: mock.resolve }),
}));
import {
  createDiningSettledSessionEvidence,
  createDiningSessionClosingEvidence,
} from "./dining-settled-session-evidence.js";
const id = (n: number) => "0190fad5-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T01:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
beforeEach(() => vi.resetAllMocks());
function setup(unresolved = false) {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    query = { diningSessionReference: id(4), observedAt: at },
    authorize = vi.fn(async () => true);
  const fact = {
    ...scope,
    orderReference: id(5),
    orderVersion: 4,
    orderCheckpoint: id(6),
    finalityReference: id(7),
    classification: "Settled",
    decidedAt: "2026-09-20T00:00:00.000Z",
    currencyCode: "CAD",
    pricedOrderTotalMinor: "100",
    capturedMinor: "120",
    capturedOrderAllocationMinor: "100",
    capturedTipMinor: "20",
  };
  const current = {
    settlement: { classification: "Settled" },
    execution: { kitchenEvidenceComplete: true, items: [{ orderBatchReference: id(8) }] },
    cancellation: { pendingCount: 0 },
    priced: { pendingAmendmentCount: 0, pricedTotalMinor: 100n },
    financial: {
      currencyCode: "CAD",
      capturedMinor: 120n,
      capturedOrderAllocationMinor: 100n,
      capturedTipMinor: 20n,
    },
    tasks: { taskSources: [{ tasks: [] as unknown[] }] },
    snapshotDigest: digest,
  };
  const closure = {
    status: "Closed",
    orderVersion: 4,
    orderCheckpoint: id(6),
    financialFinalityReference: id(7),
    snapshotDigest: digest,
  };
  mock.load.mockResolvedValue({
    ...scope,
    ...query,
    orders: [
      {
        inventory: { orderReference: id(5), batches: [{ orderBatchReference: id(8) }] },
        closure,
        current,
        historicalFinality: fact,
      },
    ],
  });
  mock.summary.mockReturnValue({ phase: "Fulfilled" });
  mock.resolve.mockResolvedValue({ outcome: "Cleared" });
  const source = (
    unresolved ? createDiningSessionClosingEvidence : createDiningSettledSessionEvidence
  )({
    ...scope,
    diningScope: scope,
    paymentScope: { ...scope, providerAccountReference: id(9), environment: "Test" },
    authorize,
    authorizeKitchen: authorize,
    authorizeDining: authorize,
    authorizeAndFence: authorize,
  });
  return {
    fact,
    current,
    closure,
    authorize,
    run: () => source.load({ query: vi.fn() }, query, 3),
  };
}
it("binds old finality to current equal owner facts without rewriting its time", async () => {
  const f = setup();
  const result = await f.run();
  expect(result.evidenceVersion).toBe(3);
  expect(result.orders[0]?.ownerDecidedAt).toBe(f.fact.decidedAt);
  expect(result.orders[0]?.financialClass).toBe("Settled");
  expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["balance", "refund", "open", "version", "pending", "kitchen", "batch"])(
  "blocks changed or incomplete %s",
  async (kind) => {
    const f = setup();
    if (kind === "balance") f.current.financial.capturedMinor = 121n;
    if (kind === "refund") f.current.settlement.classification = "Indeterminate";
    if (kind === "open") f.closure.status = "Open";
    if (kind === "version") f.fact.orderVersion = 3;
    if (kind === "pending") f.current.cancellation.pendingCount = 1;
    if (kind === "kitchen") f.current.execution.kitchenEvidenceComplete = false;
    if (kind === "batch") mock.summary.mockReturnValue({ phase: "Preparing" });
    await expect(f.run()).rejects.toThrow();
  },
);
it.each(["Unknown", "Blocking"])(
  "does not clear Dining critical task when owner says %s",
  async (outcome) => {
    const f = setup();
    f.current.tasks.taskSources[0]?.tasks.push({
      taskReference: id(10),
      severityCode: "CRITICAL",
      taskType: "DINING_UNPAID_BATCH_EXCEPTION",
      source: { sourceType: "DINING_SESSION" },
    });
    mock.resolve.mockResolvedValue({ outcome });
    await expect(f.run()).rejects.toThrow();
  },
);
it("blocks unknown critical source even if its status says Done", async () => {
  const f = setup();
  f.current.tasks.taskSources[0]?.tasks.push({
    taskReference: id(10),
    severityCode: "CRITICAL",
    taskType: "TERMINAL_CAPTURE_WATCHDOG",
    status: "Done",
    source: { sourceType: "PAYMENT_ATTEMPT" },
  });
  await expect(f.run()).rejects.toThrow();
});
it("rechecks session authority", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
});

it.each(["Unpaid", "Indeterminate"])(
  "provides terminal unresolved %s evidence without inventing finality",
  async (classification) => {
    const f = setup(true);
    const data = await mock.load();
    data.orders[0].historicalFinality = null;
    f.closure.status = "Open";
    data.orders[0].closure.financialFinalityReference = null;
    f.current.settlement.classification = classification;
    const evidence = await f.run();
    expect(evidence.orders[0]).toMatchObject({
      financialClass: classification,
      orderClosureStatus: "Open",
      ownerFinalityReference: null,
      ownerDecidedAt: null,
    });
  },
);
it.each(["nonterminal", "finality", "closed", "pending", "kitchen", "unknown-task"])(
  "blocks unresolved closing with %s",
  async (kind) => {
    const f = setup(true);
    const data = await mock.load();
    data.orders[0].historicalFinality = null;
    f.closure.status = "Open";
    data.orders[0].closure.financialFinalityReference = null;
    f.current.settlement.classification = "Unpaid";
    if (kind === "nonterminal") mock.summary.mockReturnValue({ phase: "Submitted" });
    if (kind === "finality") data.orders[0].historicalFinality = f.fact;
    if (kind === "closed") f.closure.status = "Closed";
    if (kind === "pending") f.current.cancellation.pendingCount = 1;
    if (kind === "kitchen") f.current.execution.kitchenEvidenceComplete = false;
    if (kind === "unknown-task")
      f.current.tasks.taskSources[0]?.tasks.push({
        severityCode: "CRITICAL",
        taskType: "UNKNOWN",
        source: { sourceType: "ORDER" },
      });
    await expect(f.run()).rejects.toThrow("DINING_SETTLED_SESSION_EVIDENCE_UNAVAILABLE");
  },
);
