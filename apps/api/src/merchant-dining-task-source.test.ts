import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn(), owner: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningClosingStore: mock.owner,
}));
import { createTaskRecord, parseTaskReference } from "@bop/task";
import { createMerchantDiningTaskSource } from "./merchant-dining-task-source.js";
const id = (n: number) =>
    parseTaskReference("0190fad3-0000-7000-8000-" + String(n).padStart(12, "0")),
  at = "2026-09-20T00:00:00.000Z";
const assignment = {
  assignmentReference: id(6),
  target: { kind: "Queue", reference: id(7) },
  assignedBy: id(8),
  assignedAt: at,
  reasonCode: "MANAGER_REVIEW",
};
const task = createTaskRecord({
  taskReference: id(10),
  scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
  source: {
    sourceType: "DINING_SESSION",
    sourceReference: id(4),
    snapshotDigest: "sha256:" + "a".repeat(64),
  },
  taskType: "DINING_UNPAID_BATCH_EXCEPTION",
  severityCode: "CRITICAL",
  priorityCode: "CRITICAL",
  status: "Assigned",
  assignmentHistory: [assignment],
  currentAssignment: assignment,
  claimHistory: [],
  currentClaim: null,
  dueAt: at,
  escalationPolicyReference: id(5),
  escalationHistory: [],
  terminalOutcome: null,
  version: 2,
  createdAt: at,
  updatedAt: at,
});

const session = {
  diningSessionReference: id(4),
  brandReference: id(2),
  storeReference: id(3),
  tableReference: id(11),
  tableAssignmentVersion: 1,
  phase: "Active",
  version: 1,
  startedByActorReference: id(8),
  startedAt: at,
  hostParticipantReference: null,
};
function fixture() {
  const scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(8),
      queueReference: id(7),
      storeLabel: "Synthetic",
      canClaim: true,
    },
    allowed = vi.fn(async () => true),
    tx = { query: vi.fn() };
  const current = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(8),
    allowed,
  };
  mock.resolve.mockResolvedValue(current);
  mock.load.mockResolvedValue(session);
  mock.owner.mockReturnValue({ load: mock.load });
  const read = createMerchantDiningTaskSource({ now: () => at } as Parameters<
    typeof createMerchantDiningTaskSource
  >[0]);
  return {
    scope,
    allowed,
    current,
    tx,
    read: () => read(tx, scope, task, "synthetic-cookie"),
    authorize: read,
  };
}
beforeEach(() => vi.resetAllMocks());
it.each(["Active", "Closing", "Closed", "Cancelled"])(
  "retains authorized exception visibility for %s source",
  async (phase) => {
    const f = fixture();
    mock.load.mockResolvedValue({ ...session, phase });
    expect(await f.read()).toBe(true);
    expect(mock.resolve).toHaveBeenCalledWith(f.tx, "synthetic-cookie", "dining.session.close");
    expect(mock.load).toHaveBeenCalledWith(id(4));
    const runner = mock.owner.mock.calls[0]?.[0];
    expect(await runner.run(async (tx: unknown) => tx)).toBe(f.tx);
    expect(f.allowed).toHaveBeenCalledTimes(2);
  },
);
it("denies foreign actor and Store before source lookup", async () => {
  const f = fixture();
  f.current.actorReference = id(99);
  expect(await f.read()).toBe(false);
  f.current.actorReference = id(8);
  f.current.store.storeReference = id(99);
  expect(await f.read()).toBe(false);
  expect(mock.owner).not.toHaveBeenCalled();
});
it("does not replace source permission with Task permission", async () => {
  const f = fixture();
  f.allowed.mockResolvedValue(false);
  expect(await f.read()).toBe(false);
  expect(mock.load).not.toHaveBeenCalled();
});
it("trims missing sources and current permission revocation", async () => {
  const f = fixture();
  mock.load.mockResolvedValue(null);
  expect(await f.read()).toBe(false);
  mock.load.mockResolvedValue(session);
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await f.read()).toBe(false);
});
it("fails unavailable on owner errors or inconsistent source binding", async () => {
  const f = fixture();
  mock.load.mockRejectedValue(new Error("private"));
  await expect(f.read()).rejects.toThrow("MERCHANT_TASK_SOURCE_UNAVAILABLE");
  mock.load.mockResolvedValue({ ...session, storeReference: id(99) });
  await expect(f.read()).rejects.toThrow("MERCHANT_TASK_SOURCE_UNAVAILABLE");
});
it("trims unsupported source types before authority or owner reads", async () => {
  const f = fixture();
  expect(
    await f.authorize(
      f.tx,
      f.scope,
      createTaskRecord({ ...task, source: { ...task.source, sourceType: "OTHER_SOURCE" } }),
      "synthetic-cookie",
    ),
  ).toBe(false);
  expect(mock.resolve).not.toHaveBeenCalled();
});
