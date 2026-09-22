import { expect, it, vi } from "vitest";
import { createTaskRecord, parseTaskReference, type TaskReference } from "@bop/task";
import { createMerchantTaskInboxRead } from "./merchant-task-inbox-read.js";
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
  const tx = { query: vi.fn() },
    scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(8),
      queueReference: id(7),
      storeLabel: "Synthetic Store",
      canClaim: true,
    };
  const page = {
    scope: task.scope,
    queueReference: id(7),
    observedAt: task.updatedAt,
    items: [task],
    nextAfterTaskReference: null as TaskReference | null,
  };
  const authorize = vi.fn(async () => scope),
    authorizeSource = vi.fn(async () => true),
    list = vi.fn(async () => page);
  const read = createMerchantTaskInboxRead({
    now: () => at,
    transactions: { run: async (work) => work(tx) },
    authorize,
    authorizeSource,
    queue: () => ({ list }),
  });
  return { read, scope, page, authorize, authorizeSource, list };
}
it("returns only authorized presentation fields without Task history or actor identity", async () => {
  const f = fixture(),
    view = await f.read("synthetic-cookie", { afterTaskReference: null });
  expect(view.screenId).toBe("TASK-INBOX");
  expect(view.items).toHaveLength(1);
  expect(view.items[0]).toMatchObject({
    taskReference: task.taskReference,
    status: "Assigned",
    canClaim: true,
    ownerStatus: "Unclaimed",
  });
  expect(view.items[0]).not.toHaveProperty("assignmentHistory");
  expect(view.items[0]).not.toHaveProperty("actorReference");
  expect(Object.isFrozen(view.items)).toBe(true);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("trims inaccessible source tasks without losing the continuation", async () => {
  const f = fixture();
  f.authorizeSource.mockResolvedValue(false);
  f.page.nextAfterTaskReference = task.taskReference;
  const view = await f.read("synthetic-cookie", { afterTaskReference: null });
  expect(view.items).toEqual([]);
  expect(view.nextAfterTaskReference).toBe(task.taskReference);
});
it("rejects Store switches before returning a page", async () => {
  const f = fixture();
  f.authorize
    .mockResolvedValueOnce(f.scope)
    .mockResolvedValue({ ...f.scope, storeReference: id(99) });
  await expect(f.read("synthetic-cookie", { afterTaskReference: null })).rejects.toThrow(
    "MERCHANT_TASK_INBOX_UNAVAILABLE",
  );
});
it("rejects source permission read failures rather than treating them as no tasks", async () => {
  const f = fixture();
  f.authorizeSource.mockRejectedValue(new Error("synthetic"));
  await expect(f.read("synthetic-cookie", { afterTaskReference: null })).rejects.toThrow();
});
it("rejects malformed continuation or tasks at the cursor", async () => {
  const f = fixture();
  f.page.nextAfterTaskReference = id(99);
  await expect(f.read("synthetic-cookie", { afterTaskReference: null })).rejects.toThrow();
  f.page.nextAfterTaskReference = null;
  await expect(
    f.read("synthetic-cookie", { afterTaskReference: task.taskReference }),
  ).rejects.toThrow();
});
it("suppresses claim affordance when permission is absent", async () => {
  const f = fixture();
  f.scope.canClaim = false;
  expect((await f.read("synthetic-cookie", { afterTaskReference: null })).items[0]?.canClaim).toBe(
    false,
  );
});
