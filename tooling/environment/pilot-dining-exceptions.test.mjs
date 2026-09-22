import { beforeEach, afterEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  discoverFactory: vi.fn(),
  discover: vi.fn(),
  taskFactory: vi.fn(),
  task: vi.fn(),
  sourceFactory: vi.fn(),
  source: vi.fn(),
  financialFactory: vi.fn(),
  financial: vi.fn(),
  historyFactory: vi.fn(),
  history: vi.fn(),
  closureFactory: vi.fn(),
  closure: vi.fn(),
}));
vi.mock("../../packages/bop/task/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresTaskStore: d.taskFactory,
}));
vi.mock("../../packages/rms/dining/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresDiningExceptionTaskCandidates: d.discoverFactory,
  createPostgresDiningExceptionTaskSource: d.sourceFactory,
}));
vi.mock("../../apps/api/dist/dining-exception-financial-evidence.js", () => ({
  createDiningExceptionFinancialEvidence: d.financialFactory,
}));
vi.mock("../../packages/rms/ordering/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresOrderClosureHistory: d.historyFactory,
}));
vi.mock("../../apps/api/dist/order-closure-finality-evidence.js", () => ({
  createOrderClosureFinalityEvidence: d.closureFactory,
}));
import {
  createInternalDiningExceptionEpisodes,
  createInternalDiningExceptionEpisodePageRunner,
} from "./pilot-dining-exception-episodes.mjs";
import { createTaskRecord } from "../../packages/bop/task/src/index.ts";
import { createInternalDiningExceptionResolution } from "./pilot-dining-exception-resolution.mjs";
import { createInternalDiningExceptionPageRunner } from "./pilot-dining-exceptions.mjs";
import { createInternalDiningExceptions } from "./pilot-dining-exceptions.mjs";
const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z",
  end = "2026-09-22T00:00:00.000Z";
function setup() {
  const tx = {},
    scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    now = vi.fn(() => at);
  const resources = {
    scope,
    now,
    publicProfile: { binding: { ...scope, validUntil: end } },
    transactions: { run: (work) => work(tx) },
  };
  const task = {
      taskReference: id(10),
      version: 4,
      status: "Completed",
      scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
      taskType: "DINING_UNPAID_BATCH_EXCEPTION",
      source: { sourceType: "DINING_SESSION", sourceReference: id(11) },
      updatedAt: at,
    },
    association = {
      ...scope,
      taskReference: id(10),
      taskVersion: 4,
      diningSessionReference: id(11),
      orderReference: id(12),
      observedAt: at,
    };
  d.task.mockResolvedValue(task);
  d.source.mockResolvedValue(association);
  return {
    scope,
    tx,
    now,
    task,
    association,
    resources,
    read: createInternalDiningExceptions(resources),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  d.discoverFactory.mockReturnValue(d.discover);
  d.taskFactory.mockReturnValue({ load: d.task });
  d.sourceFactory.mockReturnValue({ load: d.source });
  d.financialFactory.mockReturnValue(d.financial);
  d.historyFactory.mockReturnValue(d.history);
  d.closureFactory.mockReturnValue(d.closure);
  d.discover.mockResolvedValue({ items: [id(10)], nextAfterTaskReference: null });
});
afterEach(() => vi.unstubAllEnvs());
it("reads current Task and owner association without treating Completed as financial resolution", async () => {
  const f = setup();
  const page = await f.read({ afterTaskReference: null, limit: 5 });
  expect(page.items[0]).toEqual({ task: f.task, association: f.association });
  expect(page.items[0]).not.toHaveProperty("resolved");
  expect(d.source).toHaveBeenCalledWith(f.tx, { task: f.task, observedAt: at });
});
it("restricts Task reads to exact candidate/transaction and denies writes", async () => {
  const f = setup();
  d.task.mockImplementationOnce(async () => {
    const options = d.taskFactory.mock.calls[0][0];
    expect(
      await options.authorizeAndFence(f.tx, { operation: "Read", taskReference: id(10) }),
    ).toBe(true);
    expect(
      await options.authorizeAndFence(f.tx, { operation: "Read", taskReference: id(99) }),
    ).toBe(false);
    expect(await options.authorizeAndFence({}, { operation: "Read", taskReference: id(10) })).toBe(
      false,
    );
    expect(await options.authorizeAndFence(f.tx, { operation: "Write" })).toBe(false);
    return f.task;
  });
  await f.read({ afterTaskReference: null, limit: 5 });
  expect(
    await d.taskFactory.mock.calls[0][0].authorizeAndFence(f.tx, {
      operation: "Read",
      taskReference: id(10),
    }),
  ).toBe(false);
});
it("refuses missing Task, scope mismatch or stale association", async () => {
  const f = setup();
  d.task.mockResolvedValueOnce(null);
  await expect(f.read({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
  d.source.mockResolvedValueOnce({ ...f.association, taskVersion: 3 });
  await expect(f.read({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
  d.task.mockResolvedValueOnce({ ...f.task, scope: { ...f.task.scope, storeReference: id(99) } });
  await expect(f.read({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
});
it("refuses expired configuration and expiry during read", async () => {
  const f = setup();
  d.source.mockImplementationOnce(async () => {
    f.now.mockReturnValue(end);
    return f.association;
  });
  await expect(f.read({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
  expect(() => createInternalDiningExceptions(f.resources)).toThrow();
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createInternalDiningExceptions(f.resources)).toThrow();
});

it("allows normalized current Task evidence only while the retained transaction is active", async () => {
  const f = setup();
  d.source.mockImplementationOnce(async () => {
    const options = d.sourceFactory.mock.calls[0][0];
    expect(await options.authorizeAndFence(f.tx, JSON.parse(JSON.stringify(f.task)), at)).toBe(
      true,
    );
    expect(await options.authorizeAndFence(f.tx, { ...f.task, version: 3 }, at)).toBe(false);
    expect(await options.authorizeAndFence({}, f.task, at)).toBe(false);
    return f.association;
  });
  await f.read({ afterTaskReference: null, limit: 5 });
  expect(await d.sourceFactory.mock.calls[0][0].authorizeAndFence(f.tx, f.task, at)).toBe(false);
});

it("invalidates consumer authority after success or failure and rejects expiry during consumption", async () => {
  const f = setup();
  let retained;
  const run = createInternalDiningExceptionPageRunner(f.resources, async (context) => {
    retained = context;
    expect(context.tx).toBe(f.tx);
    expect(context.authorize()).toBe(true);
    f.now.mockReturnValue(end);
    return context.page;
  });
  await expect(run({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
  expect(retained.authorize()).toBe(false);
  f.now.mockReturnValue(at);
  expect(retained.authorize()).toBe(false);
});
function resolving() {
  const f = setup();
  const assignment = {
    assignmentReference: id(20),
    target: { kind: "Queue", reference: id(21) },
    assignedBy: id(22),
    assignedAt: at,
    reasonCode: "MANAGER_REVIEW",
  };
  const task = createTaskRecord({
    ...f.task,
    status: "Assigned",
    severityCode: "CRITICAL",
    priorityCode: "CRITICAL",
    source: { ...f.task.source, snapshotDigest: "sha256:" + "a".repeat(64) },
    assignmentHistory: [assignment],
    currentAssignment: assignment,
    claimHistory: [],
    currentClaim: null,
    dueAt: at,
    escalationPolicyReference: id(23),
    escalationHistory: [],
    terminalOutcome: null,
    createdAt: at,
  });
  d.task.mockResolvedValue(task);
  d.source.mockResolvedValue({
    ...f.association,
    evidenceVersion: 1,
    evidenceDigest: "a".repeat(64),
    intentHash: "b".repeat(64),
    requestedAt: at,
  });
  const fact = {
    ...f.scope,
    orderReference: id(12),
    orderVersion: 3,
    observedAt: at,
    financialClass: "Settled",
    ownerFinalityReference: id(24),
    ownerDecidedAt: at,
  };
  d.financial.mockResolvedValue({ orderVersion: 3, financial: fact });
  return {
    ...f,
    fact,
    run: createInternalDiningExceptionResolution({
      resources: f.resources,
      providerAccountReference: id(25),
    }),
  };
}
it.each([
  ["Settled", "Cleared"],
  ["Unpaid", "Blocking"],
  ["Indeterminate", "Blocking"],
  [null, "Unknown"],
])(
  "resolves %s through the real Dining resolver using retained owner evidence",
  async (financialClass, outcome) => {
    const f = resolving();
    d.financial.mockResolvedValue({
      orderVersion: 3,
      financial:
        financialClass === null
          ? null
          : {
              ...f.fact,
              financialClass,
              ownerFinalityReference: financialClass === "Settled" ? id(24) : null,
              ownerDecidedAt: financialClass === "Settled" ? at : null,
            },
    });
    const result = await f.run({ afterTaskReference: null, limit: 5 });
    expect(result.items[0].resolution).toMatchObject({ outcome, orderVersion: 3, taskVersion: 4 });
    expect(d.financial).toHaveBeenCalledWith(f.tx, { orderReference: id(12), observedAt: at });
    expect(d.financialFactory.mock.calls[0][0]).toMatchObject({
      scope: f.scope,
      environment: "Test",
      providerAccountReference: id(25),
    });
  },
);
it("limits financial authority to the retained transaction, order and observation time", async () => {
  const f = resolving();
  d.financial.mockImplementationOnce(async () => {
    const { authorize } = d.financialFactory.mock.calls[0][0];
    const q = { orderReference: id(12), observedAt: at };
    expect(await authorize(f.tx, q)).toBe(true);
    expect(await authorize({}, q)).toBe(false);
    expect(await authorize(f.tx, { ...q, orderReference: id(99) })).toBe(false);
    expect(await authorize(f.tx, { ...q, observedAt: end })).toBe(false);
    return { orderVersion: 3, financial: f.fact };
  });
  await f.run({ afterTaskReference: null, limit: 5 });
  expect(
    await d.financialFactory.mock.calls[0][0].authorize(f.tx, {
      orderReference: id(12),
      observedAt: at,
    }),
  ).toBe(false);
});
it("rejects changed financial identity/version and expiry rather than returning clearance", async () => {
  const f = resolving();
  for (const financial of [
    { ...f.fact, orderReference: id(99) },
    { ...f.fact, orderVersion: 2 },
  ]) {
    d.financial.mockResolvedValueOnce({ orderVersion: 3, financial });
    await expect(f.run({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
  }
  d.financial.mockImplementationOnce(async () => {
    f.now.mockReturnValue(end);
    return { orderVersion: 3, financial: f.fact };
  });
  await expect(f.run({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
});

async function episodes() {
  const f = resolving();
  const requestedAt = "2026-09-20T23:57:00.000Z",
    closedAt = "2026-09-20T23:59:00.000Z";
  const task = await d.task(),
    association = await d.source();
  d.task.mockResolvedValue(createTaskRecord({ ...task, createdAt: requestedAt }));
  d.source.mockResolvedValue({ ...association, requestedAt });
  const closed = {
    ...f.scope,
    orderReference: id(12),
    orderVersion: 2,
    closureReference: id(30),
    closureVersion: 1,
    status: "Closed",
    occurredAt: closedAt,
  };
  const history = {
    position: {
      ...f.scope,
      orderReference: id(12),
      observedAt: at,
      orderVersion: 3,
      status: "Open",
    },
    records: [closed],
  };
  d.history.mockResolvedValue(history);
  const evidence = {
    closure: closed,
    finality: { finalityReference: id(31), decidedAt: "2026-09-20T23:58:00.000Z" },
  };
  d.closure.mockResolvedValue(evidence);
  return {
    ...f,
    history,
    evidence,
    requestedAt,
    run: createInternalDiningExceptionEpisodes({
      resources: f.resources,
      providerAccountReference: id(25),
    }),
  };
}
it("binds the historical episode in the retained transaction independently of current financial status", async () => {
  const f = await episodes();
  const result = await f.run({ afterTaskReference: null, limit: 5 });
  expect(result.items[0].episode).toMatchObject({
    outcome: "ResolvedEpisode",
    orderVersion: 3,
    historicalOrderVersion: 2,
    ownerFinalityReference: id(31),
  });
  expect(d.closure).toHaveBeenCalledWith(f.tx, {
    orderReference: id(12),
    closureReference: id(30),
    observedAt: at,
  });
  expect(d.financial).not.toHaveBeenCalled();
  expect(d.closureFactory.mock.calls[0][0]).toMatchObject({
    environment: "Test",
    providerAccountReference: id(25),
  });
  expect(
    await d.closureFactory.mock.calls[0][0].authorize(f.tx, {
      orderReference: id(12),
      observedAt: at,
    }),
  ).toBe(false);
});
it("keeps old/equal-clock settlement unresolved and selects the first later committed outcome", async () => {
  const f = await episodes();
  f.evidence.finality.decidedAt = f.requestedAt;
  expect((await f.run({ afterTaskReference: null, limit: 5 })).items[0].episode.outcome).toBe(
    "UnresolvedEpisode",
  );
  const later = { ...f.evidence.closure, closureReference: id(32), closureVersion: 3 };
  f.history.records.push(later);
  d.closure.mockImplementation(async (_tx, q) =>
    q.closureReference === id(30)
      ? f.evidence
      : {
          closure: later,
          finality: { finalityReference: id(33), decidedAt: "2026-09-20T23:58:30.000Z" },
        },
  );
  expect(
    (await f.run({ afterTaskReference: null, limit: 5 })).items[0].episode.ownerFinalityReference,
  ).toBe(id(33));
  f.evidence.finality.decidedAt = "2026-09-20T23:58:00.000Z";
  d.closure.mockClear();
  expect(
    (await f.run({ afterTaskReference: null, limit: 5 })).items[0].episode.ownerFinalityReference,
  ).toBe(id(31));
  expect(d.closure).toHaveBeenCalledTimes(1);
});
it("refuses disappeared or changed closure and wrong-scope history", async () => {
  const f = await episodes();
  d.closure.mockResolvedValueOnce(null);
  await expect(f.run({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
  d.closure.mockResolvedValueOnce({
    ...f.evidence,
    closure: { ...f.evidence.closure, orderVersion: 1 },
  });
  await expect(f.run({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
  f.history.position.storeReference = id(99);
  await expect(f.run({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
});
it("limits historical query scope and refuses authority expiry during owner read", async () => {
  const f = await episodes();
  d.closure.mockImplementationOnce(async () => {
    const { authorize } = d.closureFactory.mock.calls[0][0],
      q = { orderReference: id(12), observedAt: at };
    expect(await authorize(f.tx, q)).toBe(true);
    expect(await authorize({}, q)).toBe(false);
    expect(await authorize(f.tx, { ...q, orderReference: id(99) })).toBe(false);
    f.now.mockReturnValue(end);
    return f.evidence;
  });
  await expect(f.run({ afterTaskReference: null, limit: 5 })).rejects.toThrow();
});

it("maps immutable episode identity and original finality time without polling/current-version churn", async () => {
  const f = await episodes();
  const first = (await f.run({ afterTaskReference: null, limit: 5 })).items[0].source;
  expect(first).toMatchObject({
    sourceReference: id(10),
    kind: "DiningUnpaidBatch",
    sourceOwner: "Dining",
    sourceStatus: "Final",
    sourceVersion: 2n,
    resolutionEvidenceReference: id(31),
    createdAt: f.requestedAt,
    updatedAt: f.evidence.closure.occurredAt,
  });
  const task = await d.task(),
    association = await d.source();
  d.task.mockResolvedValue(createTaskRecord({ ...task, version: task.version + 1 }));
  d.source.mockResolvedValue({ ...association, taskVersion: task.version + 1 });
  f.history.position.orderVersion += 1;
  expect((await f.run({ afterTaskReference: null, limit: 5 })).items[0].source).toEqual(first);
});
it("maps missing historical resolution as Open with no invented provider or finality result", async () => {
  const f = await episodes();
  f.history.records = [];
  const source = (await f.run({ afterTaskReference: null, limit: 5 })).items[0].source;
  expect(source).toMatchObject({
    sourceStatus: "Open",
    sourceVersion: 1n,
    resolutionEvidenceReference: null,
    providerState: "NotApplicable",
    paymentReference: null,
    createdAt: f.requestedAt,
    updatedAt: f.requestedAt,
  });
});

it("retains projection consumer transaction, rereads changed owner evidence and expires callbacks", async () => {
  const f = await episodes();
  let retained;
  const run = createInternalDiningExceptionEpisodePageRunner(
    { resources: f.resources, providerAccountReference: id(25) },
    async (context) => {
      retained = context;
      expect(context.tx).toBe(f.tx);
      const source = context.page.items[0].source;
      expect(await context.rereadSource(source.sourceReference)).toEqual(source);
      f.history.records = [];
      expect((await context.rereadSource(source.sourceReference)).sourceStatus).toBe("Open");
      await expect(context.rereadSource(id(99))).rejects.toThrow();
      return context.page;
    },
  );
  await run({ afterTaskReference: null, limit: 5 });
  expect(retained.authorize()).toBe(false);
  await expect(retained.rereadSource(id(10))).rejects.toThrow();
});
