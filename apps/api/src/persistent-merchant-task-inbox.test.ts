import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), queue: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.resolve }));
vi.mock("@bop/task", async (original) => ({
  ...(await original<typeof import("@bop/task")>()),
  createPostgresTaskQueueReader: mocks.queue,
}));
import { createTaskRecord, parseTaskReference } from "@bop/task";
import { createPersistentMerchantTaskInbox } from "./persistent-merchant-task-inbox.js";
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

function fixture() {
  const allowed = vi.fn(async () => true),
    authorizeAction = vi.fn(async () => ({ effect: "Allow" })),
    tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const resolved = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3), displayName: "Synthetic Store" },
    actorReference: id(8),
    allowed,
    authorizeAction,
  };
  mocks.resolve.mockResolvedValue(resolved);
  mocks.queue.mockImplementation((options) => ({
    list: async (transaction: unknown, query: unknown) => {
      if (!(await options.authorizeAndFence(transaction, query))) throw new Error("denied");
      const page = {
        scope: task.scope,
        queueReference: id(7),
        observedAt: at,
        items: [task],
        nextAfterTaskReference: null,
      };
      if (!(await options.authorizeAndFence(transaction, query))) throw new Error("denied");
      return page;
    },
  }));
  const queue = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    queueReference: id(7),
    effectiveFrom: at,
    effectiveUntil: "2026-09-21T00:00:00.000Z",
  };
  const source = {
    now: () => at,
    transactions: { run: async (work: (tx: unknown) => unknown) => work(tx) },
  };
  const authorizeSource = vi.fn(async (transaction: unknown) => {
    expect(transaction).toBeDefined();
    return true;
  });
  const read = createPersistentMerchantTaskInbox({
    persistence: source as unknown as Parameters<
      typeof createPersistentMerchantTaskInbox
    >[0]["persistence"],
    queue,
    authorizeSource,
  });
  return { read, allowed, resolved, queue, source, authorizeAction, authorizeSource, tx };
}
beforeEach(() => vi.clearAllMocks());
it("composes current scope, public queue and source authorization in one transaction", async () => {
  const f = fixture();
  const view = await f.read("synthetic-cookie", { afterTaskReference: null });
  expect(view.items).toHaveLength(1);
  expect(view.items[0]?.canClaim).toBe(true);
  expect(mocks.resolve).toHaveBeenCalledWith(
    expect.anything(),
    "synthetic-cookie",
    "workflow.operate",
  );
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  const tx = mocks.resolve.mock.calls[0]?.[0];
  expect(f.authorizeSource.mock.calls[0]?.[0]).toBe(tx);
  expect(f.authorizeSource).toHaveBeenCalledWith(
    tx,
    expect.anything(),
    expect.anything(),
    "synthetic-cookie",
  );
  expect(f.allowed).toHaveBeenCalledTimes(4);
  expect(await tx.query("SELECT 1", [])).toEqual({ rows: [], rowCount: 0 });
  expect(f.tx.query).toHaveBeenCalledWith("SELECT 1", []);
});
it("rejects foreign Store before queue access", async () => {
  const f = fixture();
  f.resolved.store.storeReference = id(99);
  await expect(f.read("synthetic-cookie", { afterTaskReference: null })).rejects.toThrow(
    "MERCHANT_TASK_INBOX_UNAVAILABLE",
  );
  expect(mocks.queue).not.toHaveBeenCalled();
});
it("rechecks authority during queue loading and fails on revocation", async () => {
  const f = fixture();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.read("synthetic-cookie", { afterTaskReference: null })).rejects.toThrow(
    "MERCHANT_TASK_INBOX_UNAVAILABLE",
  );
  expect(f.authorizeSource).not.toHaveBeenCalled();
});
it("does not treat claim permission as source access", async () => {
  const f = fixture();
  f.authorizeSource.mockResolvedValue(false);
  expect((await f.read("synthetic-cookie", { afterTaskReference: null })).items).toEqual([]);
});
it("allows an authorized read without granting a claim affordance", async () => {
  const f = fixture();
  f.authorizeAction.mockResolvedValue({ effect: "Deny" });
  expect((await f.read("synthetic-cookie", { afterTaskReference: null })).items[0]?.canClaim).toBe(
    false,
  );
});
it("captures server configuration and rejects expiration", async () => {
  const f = fixture();
  f.queue.storeReference = id(99);
  expect((await f.read("synthetic-cookie", { afterTaskReference: null })).items).toHaveLength(1);
  f.source.now = () => "2026-09-21T00:00:00.000Z";
  await expect(f.read("synthetic-cookie", { afterTaskReference: null })).rejects.toThrow(
    "MERCHANT_TASK_INBOX_UNAVAILABLE",
  );
});
it("isolates current authority across requests", async () => {
  const f = fixture();
  await Promise.all([
    f.read("cookie-a", { afterTaskReference: null }),
    f.read("cookie-b", { afterTaskReference: null }),
  ]);
  expect(mocks.resolve.mock.calls.map((call) => call[1])).toEqual(["cookie-a", "cookie-b"]);
});
